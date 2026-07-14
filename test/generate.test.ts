import { describe, expect, test } from "bun:test";

import { directCliSearchEnabled } from "../src/cli";
import { calculateGenerationCost, generateImage } from "../src/generate";
import { FLASH_MODEL_ID, LITE_MODEL_ID, MODEL_CAPABILITIES, PRO_MODEL_ID } from "../src/models";

describe("structured generation core", () => {
  test("preserves ordered references, omits Search by default, and returns structured usage", async () => {
    let captured: Record<string, unknown> | undefined;
    const output = new Uint8Array([1, 2, 3, 4]);
    const client = {
      models: {
        async generateContent(input: Record<string, unknown>) {
          captured = input;
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.from(output).toString("base64"),
                        mimeType: "image/png",
                      },
                    },
                    { text: "provider note" },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 752,
              thoughtsTokenCount: 2,
              totalTokenCount: 764,
              candidatesTokensDetails: [
                { modality: "IMAGE", tokenCount: 747 },
                { modality: "TEXT", tokenCount: 5 },
              ],
            },
            modelVersion: "stable-001",
            responseId: "response-1",
          };
        },
      },
    };

    const result = await generateImage(
      {
        apiKey: "not-a-real-key",
        prompt: "final prompt",
        references: [
          { bytes: new Uint8Array([10]), mimeType: "image/png" },
          { bytes: new Uint8Array([20]), mimeType: "image/jpeg" },
        ],
        modelId: FLASH_MODEL_ID,
        size: "512",
        aspectRatio: "1:1",
      },
      client,
    );

    const contents = captured?.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    const config = captured?.config as Record<string, unknown>;
    expect(contents[0].parts.map((part) => Object.keys(part)[0])).toEqual([
      "inlineData",
      "inlineData",
      "text",
    ]);
    expect((contents[0].parts[0].inlineData as { data: string }).data).toBe("Cg==");
    expect((contents[0].parts[1].inlineData as { data: string }).data).toBe("FA==");
    expect(contents[0].parts[2]).toEqual({ text: "final prompt" });
    expect(config.tools).toBeUndefined();
    expect(config.imageConfig).toEqual({ imageSize: "512", aspectRatio: "1:1" });
    expect(result.images[0].bytes).toEqual(output);
    expect(result.text).toEqual(["provider note"]);
    expect(result.usage).toEqual({
      promptTokens: 10,
      candidateTokens: 752,
      thoughtTokens: 2,
      imageOutputTokens: 747,
      textOutputTokens: 5,
      unclassifiedOutputTokens: 0,
      totalTokens: 764,
    });
    expect(result.cost.status).toBe("calculated");
    expect(result.cost.usd).toBeCloseTo(0.044846, 6);
    expect(result.modelVersion).toBe("stable-001");
    expect(result.responseId).toBe("response-1");
  });

  test("passes Search and AbortSignal only when requested", async () => {
    let captured: Record<string, unknown> | undefined;
    const controller = new AbortController();
    await generateImage(
      {
        apiKey: "not-a-real-key",
        prompt: "test",
        modelId: FLASH_MODEL_ID,
        size: "1K",
        googleSearch: true,
        abortSignal: controller.signal,
      },
      {
        models: {
          async generateContent(input) {
            captured = input;
            return { candidates: [] };
          },
        },
      },
    );
    const config = captured?.config as Record<string, unknown>;
    expect(config.tools).toEqual([{ googleSearch: {} }]);
    expect(config.abortSignal).toBe(controller.signal);
  });

  test("treats candidate tokens without modality detail as unknown output", async () => {
    const result = await generateImage(
      {
        apiKey: "not-a-real-key",
        prompt: "test",
        modelId: FLASH_MODEL_ID,
        size: "512",
      },
      {
        models: {
          async generateContent() {
            return {
              candidates: [],
              usageMetadata: {
                promptTokenCount: 2,
                candidatesTokenCount: 17,
                totalTokenCount: 19,
              },
            };
          },
        },
      },
    );
    expect(result.usage?.imageOutputTokens).toBe(0);
    expect(result.usage?.unclassifiedOutputTokens).toBe(17);
    expect(result.cost.status).toBe("upper-bound");
    expect(result.cost.usd).toBeCloseTo(0.001021, 6);
  });

  test("returns unavailable cost for an unknown exact model instead of guessing", () => {
    expect(
      calculateGenerationCost("unknown-model", {
        promptTokens: 1,
        candidateTokens: 1,
        thoughtTokens: 0,
        imageOutputTokens: 1,
        textOutputTokens: 0,
        unclassifiedOutputTokens: 0,
        totalTokens: 2,
      }),
    ).toEqual({ status: "unavailable", excludesGrounding: false });
  });

  test("prices unknown output as a conservative image-rate upper bound", () => {
    const cost = calculateGenerationCost(FLASH_MODEL_ID, {
      promptTokens: 246,
      candidateTokens: 1_084,
      thoughtTokens: 0,
      imageOutputTokens: 747,
      textOutputTokens: 0,
      unclassifiedOutputTokens: 337,
      totalTokens: 1_330,
    });

    expect(cost.status).toBe("upper-bound");
    expect(cost.usd).toBeCloseTo(0.065163, 6);
  });
});

describe("honest model capabilities", () => {
  test("uses exact GA IDs and restricts unsupported combinations", () => {
    expect(MODEL_CAPABILITIES.map((model) => model.id)).toEqual([
      FLASH_MODEL_ID,
      LITE_MODEL_ID,
      PRO_MODEL_ID,
    ]);
    expect(MODEL_CAPABILITIES.find((model) => model.id === FLASH_MODEL_ID)?.sizes).toContain("512");
    expect(MODEL_CAPABILITIES.find((model) => model.id === LITE_MODEL_ID)?.sizes).toEqual(["1K"]);
    expect(MODEL_CAPABILITIES.find((model) => model.id === LITE_MODEL_ID)?.searchGrounding).toBe(
      false,
    );
    expect(MODEL_CAPABILITIES.find((model) => model.id === PRO_MODEL_ID)?.sizes).not.toContain(
      "512",
    );
    expect(directCliSearchEnabled(FLASH_MODEL_ID)).toBe(true);
    expect(directCliSearchEnabled(LITE_MODEL_ID)).toBe(false);
  });
});
