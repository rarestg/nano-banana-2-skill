import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COLOR_PALETTES } from "../src/workbench/palettes";
import { loadRecipes, recipeFamily, renderRecipe } from "../src/workbench/recipes";

describe("provider-neutral recipes", () => {
  test("ships six built-in image and icon recipes", async () => {
    const recipes = await loadRecipes();
    expect(recipes.map((recipe) => recipe.id)).toEqual([
      "airy-pastel-modernist",
      "custom-icon",
      "custom",
      "folio-flat-cut-paper",
      "folio-geometric-isometric",
      "folio-restrained-screenprint",
    ]);
    expect(recipes.filter((recipe) => recipe.comparable)).toHaveLength(4);
    expect(recipes.filter((recipe) => recipe.kind === "custom")).toHaveLength(2);
    expect(
      recipes.filter((recipe) => recipe.kind === "custom").every((recipe) => !recipe.comparable),
    ).toBe(true);
    expect(Object.fromEntries(recipes.map((recipe) => [recipe.id, recipeFamily(recipe)]))).toEqual({
      "airy-pastel-modernist": "image",
      "custom-icon": "icon",
      custom: "image",
      "folio-flat-cut-paper": "icon",
      "folio-geometric-isometric": "icon",
      "folio-restrained-screenprint": "icon",
    });
  });

  test("keeps the subject separate from each style contract", async () => {
    const recipes = await loadRecipes();
    const geometric = recipes.find((recipe) => recipe.id === "folio-geometric-isometric");
    const custom = recipes.find((recipe) => recipe.id === "custom");
    const customIcon = recipes.find((recipe) => recipe.id === "custom-icon");
    if (!geometric || !custom || !customIcon) throw new Error("Expected built-in recipes.");
    const palette = COLOR_PALETTES[0];
    const rendered = renderRecipe(geometric, "A local transcript search tool.", palette);
    expect(rendered).toContain("Subject brief:\nA local transcript search tool.");
    expect(rendered).toContain("Flat geometric isometric tile icon");
    expect(rendered).toContain(palette.colors.join(", "));
    expect(rendered).not.toContain("{{subject}}");
    expect(rendered).not.toContain("{{colorPalette}}");
    expect(renderRecipe(custom, "Exact custom prompt", palette)).toBe("Exact custom prompt");
    expect(renderRecipe(customIcon, "Exact custom icon prompt", palette)).toBe(
      "Exact custom icon prompt",
    );
  });

  test("does not expand prompt variables inside custom or styled subjects", async () => {
    const recipes = await loadRecipes();
    const geometric = recipes.find((recipe) => recipe.id === "folio-geometric-isometric");
    const custom = recipes.find((recipe) => recipe.id === "custom");
    if (!geometric || !custom) throw new Error("Expected built-in recipes.");
    const palette = COLOR_PALETTES[0];
    const subject = "Keep {{colorPalette}} literal.";

    expect(renderRecipe(custom, subject, palette)).toBe(subject);
    expect(renderRecipe(geometric, subject, palette)).toContain(`Subject brief:\n${subject}`);
    expect(renderRecipe(geometric, subject, palette)).toContain(palette.colors.join(", "));
  });

  test("rejects whitespace-bearing prompt variables", async () => {
    const [recipe] = await loadRecipes();
    const directory = await mkdtemp(join(tmpdir(), "nano-banana-recipes-"));
    try {
      await writeFile(
        join(directory, "invalid.json"),
        JSON.stringify({ ...recipe, promptTemplate: "{{subject}} {{ colorPalette }}" }),
      );
      await expect(loadRecipes(directory)).rejects.toThrow(/unknown prompt variable/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      promptTemplate: "{{subject}} {{colorPalette}}",
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
