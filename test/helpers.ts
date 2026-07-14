import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GenerationResult } from "../src/generate";
import { FLASH_MODEL_ID } from "../src/models";
import { SessionStore, type CreateSessionInput } from "../src/workbench/store";

export async function temporaryStore() {
  const root = await mkdtemp(join(tmpdir(), "nano-banana-workbench-test-"));
  const store = new SessionStore(root);
  await store.initialize();
  return { root, store };
}

export function pngBytes() {
  return new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
}

export function sessionInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    subject: "A harmless test project with one geometric tool shape.",
    recipeIds: ["folio-geometric-isometric"],
    modelId: FLASH_MODEL_ID,
    size: "512",
    aspectRatio: "1:1",
    googleSearch: false,
    variantsPerRecipe: 4,
    references: [],
    ...overrides,
  };
}

export function svgResult(label = "mock"): GenerationResult {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#FAFAFA"/><circle cx="256" cy="256" r="150" fill="#00BBA7"/><text x="256" y="265" text-anchor="middle">${label}</text></svg>`;
  return {
    images: [{ bytes: new TextEncoder().encode(svg), mimeType: "image/svg+xml" }],
    text: [],
    usage: {
      promptTokens: 10,
      candidateTokens: 747,
      thoughtTokens: 0,
      imageOutputTokens: 747,
      textOutputTokens: 0,
      unclassifiedOutputTokens: 0,
      totalTokens: 757,
    },
    cost: { status: "calculated", usd: 0.044825, excludesGrounding: false },
    modelVersion: "mock-model",
    responseId: "mock-response",
  };
}
