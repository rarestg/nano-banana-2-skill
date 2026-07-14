import { copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

const COMMAND_TIMEOUT_MS = 30_000;
const IMAGE_ENV = {
  ...process.env,
  MAGICK_MEMORY_LIMIT: "256MiB",
  MAGICK_MAP_LIMIT: "512MiB",
  MAGICK_DISK_LIMIT: "512MiB",
  MAGICK_TIME_LIMIT: "30",
  MAGICK_THREAD_LIMIT: "2",
  MAGICK_WIDTH_LIMIT: "16384",
  MAGICK_HEIGHT_LIMIT: "16384",
  MAGICK_AREA_LIMIT: "100MP",
};

export type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export function detectImageMimeType(bytes: Uint8Array): SupportedImageMime | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString("ascii"))
  ) {
    return "image/gif";
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: options.env,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);

    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(
      ([stdout, stderr, code]) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error(`${command} exceeded the processing time limit.`));
        else if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        else reject(new Error(`${command} failed (exit ${code}): ${stderr.trim()}`));
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function findImageMagick(): string | undefined {
  return Bun.which("magick") ?? Bun.which("convert") ?? undefined;
}

async function runImageMagick(args: string[]) {
  const command = findImageMagick();
  if (!command) {
    throw new Error("ImageMagick is required (expected `magick` or `convert`).");
  }
  return runCommand(command, args, { env: IMAGE_ENV });
}

export async function imageDimensions(path: string) {
  const result = await runImageMagick([path, "-format", "%w %h", "info:"]);
  const [width, height] = result.stdout.split(/\s+/).map(Number);
  if (!width || !height) throw new Error(`Could not read image dimensions: ${path}`);
  if (width > 16_384 || height > 16_384 || width * height > 100_000_000) {
    throw new Error("Image dimensions exceed processing limits.");
  }
  return { width, height };
}

export async function validateImageBytes(
  bytes: Uint8Array,
  declaredMimeType: string,
  temporaryRoot = tmpdir(),
) {
  const detectedMimeType = detectImageMimeType(bytes);
  if (!detectedMimeType || detectedMimeType !== declaredMimeType) {
    throw new Error("Image content does not match its declared media type.");
  }
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(temporaryRoot, ".image-check-"));
  const path = join(directory, `input${extname(`file.${detectedMimeType.split("/")[1]}`)}`);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    return { mimeType: detectedMimeType, ...(await imageDimensions(path)) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function exportCircularProjectIcon(inputPath: string, outputPath: string) {
  const dimensions = await imageDimensions(inputPath);
  if (dimensions.width !== dimensions.height) {
    throw new Error("Project-icon export requires a square source image.");
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await runImageMagick([
    inputPath,
    "-auto-orient",
    "-filter",
    "Lanczos",
    "-resize",
    "384x384!",
    "-alpha",
    "on",
    "(",
    "-size",
    "384x384",
    "xc:none",
    "-fill",
    "white",
    "-draw",
    "circle 191.5,191.5 191.5,0",
    ")",
    "-compose",
    "DstIn",
    "-composite",
    "-strip",
    "-define",
    "png:compression-level=9",
    `PNG32:${outputPath}`,
  ]);

  return { path: outputPath, width: 384, height: 384 };
}

async function detectKeyColor(inputPath: string) {
  const { stdout } = await runImageMagick([
    inputPath,
    "-crop",
    "4x4+0+0",
    "+repage",
    "-format",
    "%c",
    "histogram:info:-",
  ]);
  let bestCount = 0;
  let bestColor = "00FF00";

  for (const line of stdout.split("\n")) {
    const count = line.match(/^\s*(\d+):/);
    const color = line.match(/#([0-9A-Fa-f]{6})/);
    if (count && color && Number(count[1]) > bestCount) {
      bestCount = Number(count[1]);
      bestColor = color[1];
    }
  }
  return bestColor;
}

export async function removeGreenBackground(inputPath: string) {
  const directory = dirname(inputPath);
  const name = basename(inputPath, extname(inputPath));
  const outputPath = join(directory, `${name}.png`);
  const temporaryPath = join(directory, `${name}-keyed.png`);

  try {
    const keyColor = await detectKeyColor(inputPath);
    await runCommand("ffmpeg", [
      "-y",
      "-nostdin",
      "-threads",
      "1",
      "-i",
      inputPath,
      "-vf",
      `colorkey=0x${keyColor}:0.25:0.08,despill=green`,
      "-fs",
      "536870912",
      temporaryPath,
    ]);
    await runImageMagick([temporaryPath, "-trim", "+repage", outputPath]);
    return outputPath;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function copyRawImage(inputPath: string, outputPath: string) {
  await mkdir(dirname(outputPath), { recursive: true });
  await copyFile(inputPath, outputPath);
}
