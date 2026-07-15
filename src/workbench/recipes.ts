import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { packageRoot } from "../paths";
import { type ColorPalette, palettePrompt } from "./palettes";

export interface Recipe {
  schemaVersion: 1;
  id: string;
  version: number;
  name: string;
  description: string;
  kind: "project-icon" | "artwork" | "custom";
  comparable: boolean;
  promptTemplate: string;
  preview:
    | {
        type: "folio-icon";
        sizes: number[];
        backgrounds: { light: string; dark: string };
      }
    | { type: "generic" };
  export:
    | {
        type: "folio-icon";
        width: 384;
        height: 384;
        transparentOutsideCircle: true;
      }
    | { type: "raw-only" };
}

export function recipeFamily(recipe: Recipe): "image" | "icon" {
  return recipe.export.type === "folio-icon" ? "icon" : "image";
}

const defaultRecipeDirectory = join(packageRoot(), "recipes");

function assertRecipe(value: unknown, path: string): asserts value is Recipe {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid recipe: ${path}`);
  }
  const recipe = value as Record<string, unknown>;
  const rootKeys = [
    "schemaVersion",
    "id",
    "version",
    "name",
    "description",
    "kind",
    "comparable",
    "promptTemplate",
    "preview",
    "export",
  ];
  if (
    recipe.schemaVersion !== 1 ||
    typeof recipe.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(recipe.id) ||
    !Number.isInteger(recipe.version) ||
    (recipe.version as number) < 1 ||
    typeof recipe.name !== "string" ||
    typeof recipe.description !== "string" ||
    !["project-icon", "artwork", "custom"].includes(String(recipe.kind)) ||
    typeof recipe.comparable !== "boolean" ||
    typeof recipe.promptTemplate !== "string" ||
    !recipe.promptTemplate.includes("{{subject}}") ||
    Object.keys(recipe).some((key) => !rootKeys.includes(key))
  ) {
    throw new Error(`Invalid recipe: ${path}`);
  }
  if (
    typeof recipe.preview !== "object" ||
    recipe.preview === null ||
    Array.isArray(recipe.preview)
  ) {
    throw new Error(`Invalid recipe preview: ${path}`);
  }
  const preview = recipe.preview as Record<string, unknown>;
  if (preview.type === "folio-icon") {
    if (
      Object.keys(preview).some((key) => !["type", "sizes", "backgrounds"].includes(key)) ||
      !Array.isArray(preview.sizes) ||
      !preview.sizes.length ||
      preview.sizes.some((size) => !Number.isInteger(size) || (size as number) < 1) ||
      typeof preview.backgrounds !== "object" ||
      preview.backgrounds === null ||
      Array.isArray(preview.backgrounds)
    ) {
      throw new Error(`Invalid Folio preview: ${path}`);
    }
    const backgrounds = preview.backgrounds as Record<string, unknown>;
    if (
      Object.keys(backgrounds).some((key) => !["light", "dark"].includes(key)) ||
      typeof backgrounds.light !== "string" ||
      typeof backgrounds.dark !== "string"
    ) {
      throw new Error(`Invalid Folio preview backgrounds: ${path}`);
    }
  } else if (preview.type !== "generic" || Object.keys(preview).some((key) => key !== "type")) {
    throw new Error(`Invalid recipe preview type: ${path}`);
  }
  if (typeof recipe.export !== "object" || recipe.export === null || Array.isArray(recipe.export)) {
    throw new Error(`Invalid recipe export: ${path}`);
  }
  const exportSettings = recipe.export as Record<string, unknown>;
  if (exportSettings.type === "folio-icon") {
    if (
      Object.keys(exportSettings).some(
        (key) => !["type", "width", "height", "transparentOutsideCircle"].includes(key),
      ) ||
      exportSettings.width !== 384 ||
      exportSettings.height !== 384 ||
      exportSettings.transparentOutsideCircle !== true
    ) {
      throw new Error(`Invalid Folio export: ${path}`);
    }
  } else if (
    exportSettings.type !== "raw-only" ||
    Object.keys(exportSettings).some((key) => key !== "type")
  ) {
    throw new Error(`Invalid recipe export type: ${path}`);
  }
  if (
    (recipe.kind === "project-icon" &&
      (preview.type !== "folio-icon" || exportSettings.type !== "folio-icon")) ||
    (recipe.kind === "artwork" &&
      (preview.type !== "generic" || exportSettings.type !== "raw-only")) ||
    (recipe.kind === "custom" &&
      (recipe.comparable ||
        !(
          (preview.type === "generic" && exportSettings.type === "raw-only") ||
          (preview.type === "folio-icon" && exportSettings.type === "folio-icon")
        )))
  ) {
    throw new Error(`Recipe kind does not match preview/export behavior: ${path}`);
  }
  const promptVariables = [...recipe.promptTemplate.matchAll(/{{[^{}]*}}/g)].map(
    (match) => match[0],
  );
  if (promptVariables.some((variable) => !["{{subject}}", "{{colorPalette}}"].includes(variable))) {
    throw new Error(`Recipe ${recipe.id} uses an unknown prompt variable.`);
  }
  if (recipe.kind === "custom" && promptVariables.some((variable) => variable !== "{{subject}}")) {
    throw new Error(`Custom recipe ${recipe.id} may only use the subject prompt variable.`);
  }
  if (recipe.kind !== "custom" && !promptVariables.includes("{{colorPalette}}")) {
    throw new Error(`Recipe ${recipe.id} must use the colorPalette prompt variable.`);
  }
}

export async function loadRecipes(directory = defaultRecipeDirectory) {
  const recipes: Recipe[] = [];
  for (const entry of (await readdir(directory)).sort()) {
    if (!entry.endsWith(".json")) continue;
    const path = join(directory, entry);
    const recipe: unknown = JSON.parse(await readFile(path, "utf8"));
    assertRecipe(recipe, path);
    recipes.push(recipe);
  }
  const ids = new Set(recipes.map((recipe) => recipe.id));
  if (ids.size !== recipes.length) throw new Error("Recipe IDs must be unique.");
  return recipes;
}

export function renderRecipe(recipe: Recipe, subject: string, palette: ColorPalette) {
  return recipe.promptTemplate.replace(/{{subject}}|{{colorPalette}}/g, (variable) =>
    variable === "{{subject}}" ? subject.trim() : palettePrompt(palette),
  );
}
