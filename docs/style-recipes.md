# Style recipes

A recipe is a provider-neutral, versioned description of how a subject brief is
turned into a full image prompt and how its results should be reviewed and
exported. Nano Banana is currently the only executor; the JSON format does not
contain model IDs, API keys, token prices, or provider-specific generation
knobs.

## Subject brief and style contract

Keep these concerns separate:

- The subject brief says what the image must communicate: the dominant object,
  supporting forms, semantic constraints, and exclusions specific to that
  project.
- The style contract says how every subject in a family should look: geometry,
  palette, density, background, forbidden treatments, safe area, and review
  sizes.

The `{{subject}}` variable is replaced verbatim. Non-Custom recipes also use
`{{colorPalette}}`, which is replaced by the ordered hex colors from the selected
curated palette. The Workbench stores the recipe and palette snapshots, rendered
prompt, and SHA-256 of each recipe and prompt in the session manifest. It does
not silently rewrite or improve the brief.

## Folio production language

`recipes/folio-geometric-isometric.json` is the source of truth for the current
project-icon family. Its contract is intentionally strict:

- Flat geometric isometric tile icon, not a scene.
- One dominant silhouette and at most two small supporting forms.
- Palette limited to the selected 4-12 color preset; its first color is the
  background.
- At most one thin zinc outline where a complex form needs separation.
- No texture, halftone, distressed treatment, lighting, cast shadows,
  gradients, gloss, bevels, photorealism, pseudo-text, labels, letters, logos,
  or colors outside the selected palette.
- Solid first-color circular field, critical content inside the central 70%, and
  approximately 15% circle-safe margin.
- Legibility at native 80, 96, and 112 pixels on Folio light and dark fields.

The cut-paper and restrained-screenprint recipes preserve the palette, sparse
composition, circle safety, and native-size gate while changing only the stated
style treatment.

## Fair comparison

Comparison is a controlled style test. The Workbench locks:

- Subject brief.
- Exact model ID, resolution, aspect ratio, and Search setting.
- Ordered reference bytes and hashes.
- Variants per recipe.
- Queue concurrency.

Calls are scheduled round-robin by variant, then recipe. Every result and
failure remains in the manifest. Image and icon recipes cannot be mixed in one
run. Do not selectively reroll one arm and present it as the original
comparison.

Use identical references for every arm. If references themselves encode a style
and differ between arms, that is a complete-preset comparison, not a text-only
style comparison; record that judgment in the subject or downstream review.

## Recipe format

Recipe JSON is strict. Unknown fields and mismatched discriminants are rejected.
`preview.type: "folio-icon"` requires integer native sizes plus light and dark
backgrounds. `export.type: "folio-icon"` requires the fixed 384×384 circular
RGBA contract. Artwork recipes require generic preview and raw-only export.
Custom recipes are non-comparable complete prompts and may use either the
generic/raw image contract or the Folio circular-icon contract.

Minimal custom-style recipe:

```json
{
  "schemaVersion": 1,
  "id": "my-style",
  "version": 1,
  "name": "My style",
  "description": "Short reviewer-facing description.",
  "kind": "project-icon",
  "comparable": true,
  "promptTemplate": "Create one portfolio project icon.\n\nSubject brief:\n{{subject}}\n\nColor palette:\n{{colorPalette}}\n\nStyle contract:\n...",
  "preview": {
    "type": "folio-icon",
    "sizes": [80, 96, 112],
    "backgrounds": { "light": "#FAFAFA", "dark": "#18181B" }
  },
  "export": {
    "type": "folio-icon",
    "width": 384,
    "height": 384,
    "transparentOutsideCircle": true
  }
}
```

To author another recipe manually:

1. Copy the closest JSON file in `recipes/`.
2. Give it a unique lowercase kebab-case `id` and increment its own `version`
   whenever the prompt contract changes.
3. Use `{{subject}}` and, for every non-Custom recipe, `{{colorPalette}}`.
4. Choose `kind: "project-icon"` only when Folio native previews and circular
   384px export are correct. Use `kind: "artwork"` with generic preview and raw
   export for a reusable full-frame style. `kind: "custom"` is reserved for
   complete-prompt image or icon recipes and must remain non-comparable.
5. Set `comparable: true` only when it is meaningful to compare the recipe with
   other styles under locked inputs.
6. Restart the Workbench; recipes are validated at startup.

Do not put a provider model, resolution alias, key, price, or filesystem path in
a recipe. Those belong to execution settings or the durable session.

## Reproducibility limit

The current Gemini image calls expose no seed. An exact prompt, recipe snapshot,
settings, reference order, and hashes reproduce the request and its provenance,
not identical pixels. Preserve selected raw bytes when pixel identity matters.
