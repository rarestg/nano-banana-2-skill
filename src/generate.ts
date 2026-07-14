import { GoogleGenAI } from "@google/genai";

import { getModelPricing, type AspectRatio, type ImageSize } from "./models";

export interface ReferenceImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface GenerateRequest {
  apiKey: string;
  prompt: string;
  references?: ReferenceImage[];
  modelId: string;
  size: ImageSize;
  aspectRatio?: AspectRatio;
  googleSearch?: boolean;
  abortSignal?: AbortSignal;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface GenerationUsage {
  promptTokens: number;
  candidateTokens: number;
  thoughtTokens: number;
  imageOutputTokens: number;
  textOutputTokens: number;
  unclassifiedOutputTokens: number;
  totalTokens: number;
}

export interface GenerationCost {
  status: "calculated" | "upper-bound" | "unavailable";
  usd?: number;
  excludesGrounding: boolean;
}

export interface GenerationResult {
  images: GeneratedImage[];
  text: string[];
  usage?: GenerationUsage;
  cost: GenerationCost;
  modelVersion?: string;
  responseId?: string;
}

interface ResponsePart {
  inlineData?: { data?: string; mimeType?: string };
  text?: string;
  thought?: boolean;
}

interface TokenDetail {
  modality?: string;
  tokenCount?: number;
}

interface GenerateContentResponseLike {
  candidates?: Array<{ content?: { parts?: ResponsePart[] } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    candidatesTokensDetails?: TokenDetail[];
  };
  modelVersion?: string;
  responseId?: string;
}

interface GenerateContentClient {
  models: {
    generateContent(input: Record<string, unknown>): Promise<GenerateContentResponseLike>;
  };
}

function tokenCountByModality(details: TokenDetail[] | undefined, modality: string) {
  return (details ?? [])
    .filter((detail) => detail.modality === modality)
    .reduce((sum, detail) => sum + (detail.tokenCount ?? 0), 0);
}

export function calculateGenerationCost(
  modelId: string,
  usage: GenerationUsage,
  googleSearch = false,
): GenerationCost {
  const pricing = getModelPricing(modelId);
  if (!pricing) {
    return { status: "unavailable", excludesGrounding: googleSearch };
  }

  const input = (usage.promptTokens / 1_000_000) * pricing.inputPerMillion;
  const image = (usage.imageOutputTokens / 1_000_000) * pricing.imageOutputPerMillion;
  const text =
    ((usage.textOutputTokens + usage.thoughtTokens) / 1_000_000) * pricing.textOutputPerMillion;
  const unknown =
    (usage.unclassifiedOutputTokens / 1_000_000) *
    Math.max(pricing.textOutputPerMillion, pricing.imageOutputPerMillion);

  return {
    status: usage.unclassifiedOutputTokens ? "upper-bound" : "calculated",
    usd: input + image + text + unknown,
    excludesGrounding: googleSearch,
  };
}

export async function generateImage(
  request: GenerateRequest,
  client?: GenerateContentClient,
): Promise<GenerationResult> {
  const ai = client ?? new GoogleGenAI({ apiKey: request.apiKey });
  const parts: Array<Record<string, unknown>> = [];

  for (const reference of request.references ?? []) {
    parts.push({
      inlineData: {
        data: Buffer.from(reference.bytes).toString("base64"),
        mimeType: reference.mimeType,
      },
    });
  }
  parts.push({ text: request.prompt });

  const config: Record<string, unknown> = {
    responseModalities: ["IMAGE", "TEXT"],
    imageConfig: {
      imageSize: request.size,
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    },
    ...(request.googleSearch ? { tools: [{ googleSearch: {} }] } : {}),
    ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
  };

  const response = await ai.models.generateContent({
    model: request.modelId,
    config,
    contents: [{ role: "user", parts }],
  });

  const images: GeneratedImage[] = [];
  const text: string[] = [];
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) {
      images.push({
        bytes: Buffer.from(part.inlineData.data, "base64"),
        mimeType: part.inlineData.mimeType || "image/png",
      });
    } else if (part.text && !part.thought) {
      text.push(part.text);
    }
  }

  const metadata = response.usageMetadata;
  let usage: GenerationUsage | undefined;
  if (metadata) {
    const candidateTokens = metadata.candidatesTokenCount ?? 0;
    const detailedImageTokens = tokenCountByModality(metadata.candidatesTokensDetails, "IMAGE");
    const detailedTextTokens = tokenCountByModality(metadata.candidatesTokensDetails, "TEXT");
    const hasDetailedOutput = detailedImageTokens > 0 || detailedTextTokens > 0;
    usage = {
      promptTokens: metadata.promptTokenCount ?? 0,
      candidateTokens,
      thoughtTokens: metadata.thoughtsTokenCount ?? 0,
      imageOutputTokens: hasDetailedOutput ? detailedImageTokens : 0,
      textOutputTokens: hasDetailedOutput ? detailedTextTokens : 0,
      unclassifiedOutputTokens: hasDetailedOutput
        ? Math.max(0, candidateTokens - detailedImageTokens - detailedTextTokens)
        : candidateTokens,
      totalTokens: metadata.totalTokenCount ?? 0,
    };
  }

  return {
    images,
    text,
    usage,
    cost: usage
      ? calculateGenerationCost(request.modelId, usage, request.googleSearch)
      : { status: "unavailable", excludesGrounding: Boolean(request.googleSearch) },
    modelVersion: response.modelVersion,
    responseId: response.responseId,
  };
}
