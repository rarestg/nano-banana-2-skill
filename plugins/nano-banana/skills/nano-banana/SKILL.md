---
name: nano-banana
description: Generates images with the local nano-banana CLI or review Workbench. Gemini Flash is the default; Lite and Pro are available. Use the one-shot CLI for a single direct result, or the Workbench for variants, style comparison, review, durable history, and export.
---

# nano-banana

AI image generation CLI. Default model: `gemini-3.1-flash-image` (Nano Banana 2).

## /init - First-Time Setup

When the user says "init", "setup nano-banana", or "install nano-banana", run these commands to get the CLI tool on their machine. No sudo required.

**Prerequisites:** Bun must be installed. If not: `curl -fsSL https://bun.sh/install | bash`

```bash
# 1. Clone the repo
git clone https://github.com/kingbootoshi/nano-banana-2-skill.git ~/tools/nano-banana-2

# 2. Install dependencies
cd ~/tools/nano-banana-2 && bun install

# 3. Link globally (creates `nano-banana` command via Bun - no sudo)
cd ~/tools/nano-banana-2 && bun link

# 4. Set up API key
mkdir -p ~/.nano-banana
echo "GEMINI_API_KEY=<ask user for their key>" > ~/.nano-banana/.env
```

After init, the user can type `nano-banana "prompt"` from anywhere.

If `bun link` fails or the command is not found after linking, fall back to:
```bash
mkdir -p ~/.local/bin
ln -sf ~/tools/nano-banana-2/src/cli.ts ~/.local/bin/nano-banana
# Then ensure ~/.local/bin is on PATH:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Get a Gemini API key at: https://aistudio.google.com/apikey

## Quick Reference

- One-shot CLI: `nano-banana "prompt" [options]`
- Review Workbench: `nano-banana workbench`
- On exe.dev: `nano-banana workbench --host 0.0.0.0 --port 4173`; open the
  authenticated HTTPS URL printed after best-effort proxy detection (the VM's
  default port omits `:4173`). If Reflection is unavailable, use the documented
  `https://<vm-name>.exe.xyz:4173/?token=...` form with the printed token.
- Use the CLI for one direct result. Use the Workbench for variants,
  comparison, native-size review, winner selection, history, and export.
- Read `docs/style-recipes.md` only when authoring or changing recipes.
- Default CLI output: 1K, Flash model, current directory.

## Core Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output` | `nano-gen-{timestamp}` | Output filename (no extension) |
| `-s, --size` | `1K` | Image size: `512`, `1K`, `2K`, or `4K` |
| `-a, --aspect` | model default | Aspect ratio: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, etc. |
| `-m, --model` | `flash` | Model: `flash`/`nb2`, `lite`/`nb2-lite`, `pro`/`nb-pro`, or any model ID |
| `-d, --dir` | current directory | Output directory |
| `-r, --ref` | - | Reference image (can use multiple times) |
| `-t, --transparent` | - | Generate on green screen, remove background (FFmpeg) |
| `--api-key` | - | Gemini API key (overrides env/file) |
| `--costs` | - | Show cost summary |

## Models

| Alias | Model | Use When |
|-------|-------|----------|
| `flash`, `nb2` | `gemini-3.1-flash-image` | Default; supports 512-4K |
| `lite`, `nb2-lite` | `gemini-3.1-flash-lite-image` | Cheapest; 1K only, no Search grounding |
| `pro`, `nb-pro` | `gemini-3-pro-image` | Highest quality; 1K-4K |

## Sizes

| Size | Cost (Flash) | Cost (Pro) |
|------|-------------|------------|
| `512` | ~$0.045 | Flash only |
| `1K` | ~$0.067 | ~$0.134 |
| `2K` | ~$0.101 | ~$0.134 |
| `4K` | ~$0.151 | ~$0.24 |

## Aspect Ratios

Supported: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `4:5`, `5:4`, `21:9`

Use `-a` flag: `nano-banana "cinematic scene" -a 16:9`

## Key Workflows

### Basic Generation

```bash
nano-banana "minimal dashboard UI with dark theme"
nano-banana "cinematic landscape" -s 2K -a 16:9
nano-banana "quick concept sketch" -s 512
```

### Model Selection

```bash
# Default (Flash - fast, cheap)
nano-banana "your prompt"

# Pro (highest quality)
nano-banana "detailed portrait" --model pro -s 2K

# Lite (1K only; Search is disabled because the model does not support it)
nano-banana "cheap 1K concept" --model lite -s 1K
```

The CLI rejects unsupported known model/size/aspect combinations before
generation. In particular, Lite cannot be used at 512, 2K, or 4K and never
receives a Search-grounding tool.

### Reference Images (Style Transfer / Editing)

```bash
# Edit existing image
nano-banana "change the background to pure white" -r dark-ui.png -o light-ui

# Style transfer - multiple references
nano-banana "combine these two styles" -r style1.png -r style2.png -o combined
```

### Transparent Assets

```bash
nano-banana "robot mascot character" -t -o mascot
nano-banana "pixel art treasure chest" -t -o chest
```

The `-t` flag asks for a green background, then uses FFmpeg `colorkey` and
`despill` to remove that background locally. Inspect edge quality before use.

Requires: `brew install ffmpeg imagemagick`

## Reference Order Matters

- First reference: primary style/content source
- Additional references: secondary influences
- Later references remain later in the provider request; resolution is controlled only by `--size`

## Cost Tracking

Every generation is logged to `~/.nano-banana/costs.json`. The summary includes
per-model counts and totals:

```bash
nano-banana --costs
```

## Use Cases

- **Landing page assets** - product mockups, UI previews
- **Image editing** - transform existing images with prompts
- **Style transfer** - combine multiple reference images
- **Marketing materials** - hero images, feature illustrations
- **UI iterations** - quickly generate variations of designs
- **Transparent assets** - icons, logos, mascots with no background
- **Game assets** - sprites, backgrounds, characters
- **Video production** - visual elements for video compositions

## Prompt Examples

```bash
# UI mockups
nano-banana "clean SaaS dashboard with analytics charts, white background"

# Widescreen cinematic
nano-banana "cyberpunk cityscape at sunset" -a 16:9 -s 2K

# Product shots with Pro quality
nano-banana "premium software product hero image" --model pro

# Quick low-res concept
nano-banana "rough sketch of a robot" -s 512

# Dark mode UI
nano-banana "Premium SaaS chat interface, dark mode, minimal, Linear-style aesthetic"

# Game assets with transparency (green screen auto-prompted)
nano-banana "pixel art treasure chest" -t -o chest

# Portrait aspect ratio
nano-banana "mobile app onboarding screen" -a 9:16
```

## API Key Setup

The CLI resolves the Gemini API key in this order:
1. `--api-key` flag
2. `GEMINI_API_KEY` environment variable
3. `.env` file in current directory
4. `.env` file next to the CLI script
5. `~/.nano-banana/.env`

Get a key at: https://aistudio.google.com/apikey
