import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const isolatedHome = mkdtempSync(join(tmpdir(), "nano-banana-test-home-"));
const isolatedCwd = mkdtempSync(join(tmpdir(), "nano-banana-test-repo-"));
writeFileSync(join(isolatedCwd, ".env"), "GEMINI_API_KEY=must-never-be-used\n");

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(isolatedCwd, { recursive: true, force: true });
});

function runCli(args: string[]) {
  const environment = { ...process.env };
  delete environment.GEMINI_API_KEY;
  const result = Bun.spawnSync(["bun", "run", join(repositoryRoot, "src/cli.ts"), ...args], {
    cwd: isolatedCwd,
    env: {
      ...environment,
      HOME: isolatedHome,
      NANO_BANANA_TEST_NO_API_KEY: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("existing CLI contract", () => {
  test("shows help with no arguments", () => {
    const result = runCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nano Banana 2");
    expect(result.stdout).toContain('nano-banana "your prompt"');
    expect(result.stdout).toContain("-s, --size");
    expect(result.stdout).toContain("-r, --ref");
  });

  test("rejects an invalid size before generation", () => {
    const result = runCli(["test", "--size", "tiny"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid size "tiny"');
    expect(result.stderr).toContain("512, 1K, 2K, 4K");
  });

  test("rejects an invalid aspect ratio before generation", () => {
    const result = runCli(["test", "--aspect", "7:5"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid aspect ratio "7:5"');
    expect(result.stderr).toContain("1:8");
    expect(result.stderr).toContain("8:1");
  });

  test("requires a prompt when only options are supplied", () => {
    const result = runCli(["--size", "512"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No prompt provided");
  });

  test("reports the established API-key resolution guidance", () => {
    const result = runCli(["test prompt", "--size", "512"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("GEMINI_API_KEY is required");
    expect(result.stderr).toContain("~/.nano-banana/.env");
    expect(result.stdout).not.toContain("Generating image");
  });

  test("rejects unsupported Lite sizes before key resolution", () => {
    const result = runCli(["test prompt", "--model", "lite", "--size", "512"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gemini-3.1-flash-lite-image does not support 512");
    expect(result.stdout).not.toContain("Generating image");
  });

  test("restores the per-model cost breakdown", () => {
    const directory = join(isolatedHome, ".nano-banana");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "costs.json"),
      JSON.stringify([
        { model: "model-b", estimated_cost: 0.2 },
        { model: "model-a", estimated_cost: 0.1 },
        { model: "model-a", estimated_cost: 0.3 },
      ]),
    );
    const result = runCli(["--costs"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("By model:");
    expect(result.stdout).toContain("model-a: 2 generation(s), $0.4000");
    expect(result.stdout).toContain("model-b: 1 generation(s), $0.2000");
  });
});
