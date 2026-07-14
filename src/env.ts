import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { packageRoot } from "./paths";

function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1 || trimmed.slice(0, separator).trim() !== key) continue;
    const value = trimmed.slice(separator + 1).trim();
    return value.replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
}

export interface ApiKeyResolution {
  value: string | undefined;
  configured: boolean;
}

export function resolveApiKey(
  explicit?: string,
  options: { cwd?: string; home?: string } = {},
): ApiKeyResolution {
  if (process.env.NANO_BANANA_TEST_NO_API_KEY === "1") {
    return { value: undefined, configured: false };
  }
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const value =
    explicit ||
    process.env.GEMINI_API_KEY ||
    readEnvValue(join(cwd, ".env"), "GEMINI_API_KEY") ||
    readEnvValue(join(packageRoot(), ".env"), "GEMINI_API_KEY") ||
    readEnvValue(join(home, ".nano-banana", ".env"), "GEMINI_API_KEY");

  return { value, configured: Boolean(value) };
}
