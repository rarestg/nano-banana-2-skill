import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRecipes, renderRecipe } from "../src/workbench/recipes";

describe("provider-neutral recipes", () => {
  test("ships three comparable Folio styles and Custom", async () => {
    const recipes = await loadRecipes();
    expect(recipes.map((recipe) => recipe.id)).toEqual([
      "custom",
      "folio-flat-cut-paper",
      "folio-geometric-isometric",
      "folio-restrained-screenprint",
    ]);
    expect(recipes.filter((recipe) => recipe.comparable)).toHaveLength(3);
    expect(recipes.find((recipe) => recipe.id === "custom")?.comparable).toBe(false);
  });

  test("keeps the subject separate from each style contract", async () => {
    const recipes = await loadRecipes();
    const geometric = recipes.find((recipe) => recipe.id === "folio-geometric-isometric");
    const custom = recipes.find((recipe) => recipe.id === "custom");
    if (!geometric || !custom) throw new Error("Expected built-in recipes.");
    const rendered = renderRecipe(geometric, "A local transcript search tool.");
    expect(rendered).toContain("Subject brief:\nA local transcript search tool.");
    expect(rendered).toContain("Flat geometric isometric tile icon");
    expect(rendered).not.toContain("{{subject}}");
    expect(renderRecipe(custom, "Exact custom prompt")).toBe("Exact custom prompt");
  });

  test("strictly validates recipe preview and export discriminants", async () => {
    const base = {
      schemaVersion: 1,
      id: "invalid",
      version: 1,
      name: "Invalid",
      description: "Invalid recipe",
      kind: "project-icon",
      comparable: true,
      promptTemplate: "{{subject}}",
      preview: {
        type: "folio-icon",
        sizes: [80],
        backgrounds: { light: "#fff", dark: "#000" },
      },
      export: {
        type: "folio-icon",
        width: 384,
        height: 384,
        transparentOutsideCircle: true,
      },
    };
    for (const invalid of [
      { ...base, preview: { ...base.preview, sizes: ["80"] } },
      { ...base, export: { ...base.export, width: 385 } },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "nano-banana-recipes-"));
      try {
        await writeFile(join(directory, "invalid.json"), JSON.stringify(invalid));
        await expect(loadRecipes(directory)).rejects.toThrow(/Invalid Folio (preview|export)/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
