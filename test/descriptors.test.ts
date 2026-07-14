import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("skill routing and descriptors", () => {
  test("routes one-shot and review work clearly without unsupported claims", async () => {
    const skill = await Bun.file(
      join(root, "plugins", "nano-banana", "skills", "nano-banana", "SKILL.md"),
    ).text();
    const marketplace = await Bun.file(join(root, ".claude-plugin", "marketplace.json")).text();
    const plugin = await Bun.file(
      join(root, "plugins", "nano-banana", ".claude-plugin", "plugin.json"),
    ).text();

    expect(skill).toContain('One-shot CLI: `nano-banana "prompt" [options]`');
    expect(skill).toContain("Review Workbench: `nano-banana workbench`");
    expect(skill).toContain("only when authoring or changing recipes");
    expect(marketplace).toContain("Flash, Lite, and Pro");
    expect(marketplace).toContain("variants, comparison, review, and export");
    expect(plugin).toContain("Flash, Lite, and Pro");
    expect(plugin).toContain("review Workbench");
    expect(`${skill}\n${marketplace}\n${plugin}`).not.toMatch(/broadcast-grade|pixel-perfect/i);
  });
});
