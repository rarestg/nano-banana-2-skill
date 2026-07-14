#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

import { resolveApiKey } from "./env";
import { generateImage, type ReferenceImage } from "./generate";
import { removeGreenBackground } from "./image-tools";
import {
  FLASH_MODEL_ID,
  PRO_MODEL_ID,
  VALID_ASPECTS,
  VALID_SIZES,
  getModelCapability,
  resolveModel,
  validateKnownModelSettings,
  type AspectRatio,
  type ImageSize,
} from "./models";

interface Options {
  prompt: string;
  output: string;
  size: ImageSize;
  outputDir: string;
  referenceImages: string[];
  transparent: boolean;
  apiKey?: string;
  model: string;
  aspectRatio?: AspectRatio;
}

interface CostEntry {
  timestamp: string;
  model: string;
  size: string;
  aspect: string | null;
  prompt_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  output_file: string;
}

const COST_LOG_PATH = join(homedir(), ".nano-banana", "costs.json");

function help() {
  return `
\x1b[36mNano Banana 2\x1b[0m - AI Image Generation CLI
Default: Gemini 3.1 Flash Image (Nano Banana 2)

\x1b[33mUsage:\x1b[0m
  nano-banana "your prompt"
  nano-banana "your prompt" --output filename
  nano-banana "your prompt" --ref reference.png
  nano-banana workbench [--host 127.0.0.1] [--port 4173]

\x1b[33mOptions:\x1b[0m
  -o, --output      Output filename (without extension) [default: nano-gen-{timestamp}]
  -s, --size        Image size: 512, 1K, 2K, or 4K [default: 1K]
  -a, --aspect      Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, etc.
  -m, --model       Model: flash/nb2, lite/nb2-lite, pro/nb-pro, or exact model ID
  -d, --dir         Output directory [default: current directory]
  -r, --ref         Reference image(s) - can be used multiple times
  -t, --transparent Generate on green, then remove it with FFmpeg/ImageMagick
  --api-key         Gemini API key (overrides environment and files)
  --costs           Show cost summary from CLI generation history
  -h, --help        Show this help

\x1b[33mModels:\x1b[0m
  flash, nb2        ${FLASH_MODEL_ID} (default)
  lite, nb2-lite    gemini-3.1-flash-lite-image (1K only)
  pro, nb-pro       ${PRO_MODEL_ID}

\x1b[33mAspect Ratios:\x1b[0m
  ${VALID_ASPECTS.join(", ")}

\x1b[33mAPI Key:\x1b[0m
  Set GEMINI_API_KEY in your environment, a .env file, or pass --api-key.
  Get a key at: https://aistudio.google.com/apikey
`;
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseGenerationArgs(args: string[]): Options {
  const options: Options = {
    prompt: "",
    output: `nano-gen-${Date.now()}`,
    size: "1K",
    outputDir: process.cwd(),
    referenceImages: [],
    transparent: false,
    model: FLASH_MODEL_ID,
  };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "-o" || argument === "--output") {
      options.output = args[++index] ?? fail(`Missing value for ${argument}`);
    } else if (argument === "-s" || argument === "--size") {
      const size = args[++index];
      if (!VALID_SIZES.includes(size as ImageSize)) {
        fail(`Invalid size "${size}". Valid: ${VALID_SIZES.join(", ")}`);
      }
      options.size = size as ImageSize;
    } else if (argument === "-a" || argument === "--aspect") {
      const aspect = args[++index];
      if (!VALID_ASPECTS.includes(aspect as AspectRatio)) {
        fail(`Invalid aspect ratio "${aspect}". Valid: ${VALID_ASPECTS.join(", ")}`);
      }
      options.aspectRatio = aspect as AspectRatio;
    } else if (argument === "-m" || argument === "--model") {
      options.model = resolveModel(args[++index] ?? fail(`Missing value for ${argument}`));
    } else if (argument === "-d" || argument === "--dir") {
      options.outputDir = args[++index] ?? fail(`Missing value for ${argument}`);
    } else if (argument === "-r" || argument === "--ref") {
      options.referenceImages.push(args[++index] ?? fail(`Missing value for ${argument}`));
    } else if (argument === "-t" || argument === "--transparent") {
      options.transparent = true;
    } else if (argument === "--api-key") {
      options.apiKey = args[++index] ?? fail(`Missing value for ${argument}`);
    } else if (!argument.startsWith("-")) {
      options.prompt = argument;
    }
  }

  if (!options.prompt) fail("No prompt provided");
  if (options.size === "512" && options.model === PRO_MODEL_ID) {
    console.log(
      "\x1b[33mWarning:\x1b[0m 512px resolution is only available on Flash. Switching to 1K.",
    );
    options.size = "1K";
  }
  const settingsError = validateKnownModelSettings(
    options.model,
    options.size,
    options.aspectRatio,
  );
  if (settingsError) fail(settingsError);
  return options;
}

export function directCliSearchEnabled(modelId: string) {
  return getModelCapability(modelId)?.searchGrounding ?? true;
}

function mimeType(path: string) {
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    }[extname(path).toLowerCase()] ?? "image/png"
  );
}

async function loadReferences(paths: string[]): Promise<ReferenceImage[]> {
  const references: ReferenceImage[] = [];
  for (const path of paths) {
    const absolutePath = path.startsWith("/") ? path : join(process.cwd(), path);
    if (!existsSync(absolutePath)) fail(`Image not found: ${absolutePath}`);
    references.push({ bytes: await readFile(absolutePath), mimeType: mimeType(path) });
    console.log(`\x1b[32m+\x1b[0m Loaded reference: ${path}`);
  }
  return references;
}

async function logCost(entry: CostEntry) {
  await mkdir(dirname(COST_LOG_PATH), { recursive: true });
  let entries: CostEntry[] = [];
  try {
    entries = JSON.parse(await readFile(COST_LOG_PATH, "utf8"));
  } catch {}
  entries.push(entry);
  await writeFile(COST_LOG_PATH, JSON.stringify(entries, null, 2));
}

function printCostSummary() {
  let entries: CostEntry[];
  try {
    entries = JSON.parse(readFileSync(COST_LOG_PATH, "utf8"));
  } catch {
    console.log("\x1b[90mNo cost data found.\x1b[0m");
    return;
  }
  const total = entries.reduce((sum, entry) => sum + entry.estimated_cost, 0);
  console.log(`\x1b[36m[nano-banana]\x1b[0m Cost Summary`);
  console.log(`  Total generations: ${entries.length}`);
  console.log(`  Total cost:        \x1b[33m$${total.toFixed(4)}\x1b[0m`);
  const byModel = new Map<string, { count: number; cost: number }>();
  for (const entry of entries) {
    const current = byModel.get(entry.model) ?? { count: 0, cost: 0 };
    current.count++;
    current.cost += entry.estimated_cost;
    byModel.set(entry.model, current);
  }
  console.log("  By model:");
  for (const [model, summary] of [...byModel].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    console.log(`    ${model}: ${summary.count} generation(s), $${summary.cost.toFixed(4)}`);
  }
  console.log(`\x1b[90mLog: ${COST_LOG_PATH}\x1b[0m`);
}

async function runGeneration(options: Options) {
  const resolved = resolveApiKey(options.apiKey);
  if (!resolved.value) {
    console.error("\x1b[31mError:\x1b[0m GEMINI_API_KEY is required.");
    console.error("Set it with --api-key, GEMINI_API_KEY, .env, or ~/.nano-banana/.env");
    return 1;
  }

  console.log("\x1b[36m[nano-banana]\x1b[0m Generating image...");
  console.log(`\x1b[90mModel: ${options.model}\x1b[0m`);
  console.log(`\x1b[90mPrompt: ${options.prompt}\x1b[0m`);
  console.log(
    `\x1b[90mSize: ${options.size}${options.aspectRatio ? ` | Aspect: ${options.aspectRatio}` : ""}\x1b[0m`,
  );
  if (options.referenceImages.length) {
    console.log(`\x1b[90mReferences: ${options.referenceImages.join(", ")}\x1b[0m`);
  }

  const references = await loadReferences(options.referenceImages);
  const prompt = options.transparent
    ? `${options.prompt}. Place the subject on a solid bright green background (#00FF00). The background must be a single flat green color with no gradients, shadows, or variation.`
    : options.prompt;
  const result = await generateImage({
    apiKey: resolved.value,
    prompt,
    references,
    modelId: options.model,
    size: options.size,
    aspectRatio: options.aspectRatio,
    googleSearch: directCliSearchEnabled(options.model),
  });

  await mkdir(options.outputDir, { recursive: true });
  const files: string[] = [];
  for (const [index, image] of result.images.entries()) {
    const extension = image.mimeType.split("/")[1] || "png";
    const suffix = index === 0 ? "" : `_${index}`;
    const path = join(options.outputDir, `${options.output}${suffix}.${extension}`);
    await writeFile(path, image.bytes);
    files.push(path);
  }
  for (const text of result.text) console.log(`\x1b[90m${text}\x1b[0m`);

  const costUsd = result.cost.usd;
  if (result.usage && result.cost.status !== "unavailable" && costUsd !== undefined) {
    console.log(
      `\x1b[90mCost ${result.cost.status === "upper-bound" ? "upper bound" : "estimate"}: ~$${costUsd.toFixed(4)} (${result.usage.promptTokens} input + ${result.usage.candidateTokens} output tokens)\x1b[0m`,
    );
    await logCost({
      timestamp: new Date().toISOString(),
      model: options.model,
      size: options.size,
      aspect: options.aspectRatio ?? null,
      prompt_tokens: result.usage.promptTokens,
      output_tokens: result.usage.candidateTokens,
      estimated_cost: costUsd,
      output_file: files[0] ?? "",
    }).catch(() => undefined);
  }

  let finalFiles = files;
  if (options.transparent) {
    finalFiles = [];
    for (const file of files) {
      try {
        finalFiles.push(await removeGreenBackground(file));
      } catch {
        console.error(`\x1b[31mx\x1b[0m Failed to remove background: ${file}`);
        finalFiles.push(file);
      }
    }
  }

  if (!finalFiles.length) {
    console.log("\x1b[33m[nano-banana]\x1b[0m No images generated");
    return 0;
  }
  console.log(`\n\x1b[32m[nano-banana]\x1b[0m Generated ${finalFiles.length} image(s):`);
  for (const file of finalFiles) console.log(`  \x1b[32m+\x1b[0m ${file}`);
  return 0;
}

async function runWorkbench(args: string[]) {
  let host = "127.0.0.1";
  let port = 4173;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--host") host = args[++index] ?? fail("Missing --host value");
    else if (args[index] === "--port") {
      port = Number(args[++index]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        fail("Port must be an integer from 1 to 65535");
      }
    } else fail(`Unknown workbench option: ${args[index]}`);
  }
  const { startWorkbench } = await import("./workbench/server");
  await startWorkbench({ host, port });
  return new Promise<number>(() => undefined);
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(help());
    return 0;
  }
  if (args[0] === "--costs") {
    printCostSummary();
    return 0;
  }
  if (args[0] === "workbench") return runWorkbench(args.slice(1));

  try {
    return await runGeneration(parseGenerationArgs(args));
  } catch (error) {
    console.error(
      "\x1b[31m[nano-banana] Error:\x1b[0m",
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
