import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    moduleDirectory,
    join(moduleDirectory, ".."),
    join(moduleDirectory, "..", ".."),
  ];
  const root = candidates.find(
    (candidate) =>
      existsSync(join(candidate, "package.json")) &&
      existsSync(join(candidate, "recipes")) &&
      existsSync(join(candidate, "web")),
  );
  if (!root) throw new Error("Could not locate Nano Banana package assets.");
  return root;
}
