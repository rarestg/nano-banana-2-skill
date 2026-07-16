# Nano Banana 2

Local image-generation CLI and review workbench backed by the Gemini API. The
workbench adds repeatable style recipes, bounded variant generation, native-size
review, durable manifests, and production export without putting the API key in
the browser.

## Install

Requirements: [Bun](https://bun.sh),
[FFmpeg](https://ffmpeg.org), and
[ImageMagick](https://imagemagick.org). ImageMagick may provide either the
`magick` or `convert` command.

```bash
git clone https://github.com/kingbootoshi/nano-banana-2-skill.git ~/tools/nano-banana-2
cd ~/tools/nano-banana-2
bun install
bun link

mkdir -p ~/.nano-banana
echo "GEMINI_API_KEY=your_key_here" > ~/.nano-banana/.env
```

Get a key from [Google AI Studio](https://aistudio.google.com/apikey).

## Workbench

The Workbench is a desktop-only interface. Narrow and mobile viewports are not
supported product targets; do not spend implementation or test effort on
responsive features or adaptations for them. Existing narrow-layout behavior is
best-effort fallback only.

Start the loopback-only server:

```bash
nano-banana workbench
```

The command prints a launch URL containing a random token. Open that exact URL
once. The server exchanges the query token for an HttpOnly, SameSite cookie and
redirects to a clean URL; API, static, and image requests then use the cookie and
do not repeat the token. The browser receives only whether an API key is
configured, never the key itself.

The default workflow creates four independent variants with at most two calls
running concurrently. Choose Images or Icons, then choose one recipe or compare
two to three styles within that output family.
Comparison calls are interleaved round-robin and share the same subject,
provider settings, and ordered reference bytes.

Built-in recipes:

- Folio geometric isometric: current production direction.
- Folio flat cut-paper.
- Folio restrained screenprint.
- Airy pastel modernist: luminous, tactile illustration on toothy paper.
- Tenebrist oil realism: dark, theatrical volume shaped by concentrated light.
- Hard-edge geometric screenprint: exact flat shapes and modernist graphic structure.
- Ornamental miniature maximalism: disciplined intricacy, pattern, and jewel-like color.
- Refined pixel art: crisp silhouettes, deliberate pixel clusters, and restrained shading.
- Custom image: the subject field is the complete prompt with raw output.
- Custom icon: the subject field is the complete prompt with circular icon export.

The Workbench exposes only verified settings:

- Exact supported model IDs.
- Model-supported output resolutions and aspect ratios.
- Seven curated color palettes containing 4 to 12 colors; the selected palette
  is inserted into every non-Custom recipe.
- Ordered PNG, JPEG, WebP, or GIF references.
- Google Search grounding under Advanced; off by default.

A run requires explicit confirmation above eight calls or an estimated $1.
Estimates use the published per-image price for the selected model and
resolution. They exclude possible Search charges. Manifest costs use
provider-reported usage; when output modality is unknown, they are labeled as a
conservative upper estimate and charged at the highest applicable output rate.
They are not invoices.

### Output and history

Sessions are stored under:

```text
~/.nano-banana/workbench/sessions/YYYY-MM-DD/<session-id>/
```

Every session preserves recipe snapshots, exact rendered prompts, settings,
ordered reference copies and hashes, candidate states, raw images and hashes,
reported usage, calculated or upper-bound cost, selection, and exports. Regeneration creates a
new session linked with `derivedFromSessionId`; references can be copied from the
parent byte-for-byte.

Selected candidates can also be downloaded through the browser as one ZIP. The
ZIP contains byte-identical generated files for Images and production-ready
384×384 circular PNGs for Icons. Browser downloads do not create durable export
records or change the session.

Folio project-icon exports contain:

- A byte-identical copy of the selected raw image.
- A losslessly compressed 384×384 true-color RGBA PNG.
- Transparent pixels outside the circular field.
- The session manifest and copied references.

The production conversion performs Lanczos resizing, a circular alpha mask,
metadata stripping, and PNG compression. It does not recolor, quantize, redraw,
or otherwise reinterpret the image.

### Cancellation

Queued calls cancel without being submitted. For an in-flight call, the SDK's
`AbortSignal` stops the local wait, but Google warns that the service operation
may continue and remain billable. The manifest therefore records billing as
`unknown-may-be-charged` unless provider usage is returned.

### exe.dev access

Loopback is the safe default. To open the workbench through this VM's private,
authenticated exe.dev HTTPS proxy, opt into a non-loopback listener on a port in
the documented range:

```bash
nano-banana workbench --host 0.0.0.0 --port 4173
```

The local authenticated URL prints immediately. The Workbench then checks the
documented exe.dev Reflection integration without delaying startup and, when
detected, prints a second authenticated URL. Its canonical forms are
`https://<vm-name>.exe.xyz/?token=...` for the VM's default proxy port and
`https://<vm-name>.exe.xyz:4173/?token=...` for an explicit port. Detection is best-effort: if
Reflection is unavailable, the local URL remains usable and the documented
port-qualified form can be constructed manually. exe.dev only proxies
port-qualified URLs for ports from 3000 through 9999.

Open the authenticated URL once. The redirect removes its query token
immediately.

Keep the exe.dev proxy private. Proxy authentication supplements the launch
token; it does not replace it. Mutating requests require the full expected
origin—scheme and host. Behind exe.dev, the documented `X-Forwarded-Host` and
`X-Forwarded-Proto` headers establish that HTTPS origin. See the
[exe.dev proxy documentation](https://exe.dev/docs/proxy).

## Style recipes

Recipes are provider-neutral JSON files in `recipes/`. They separate a reusable
style contract from the subject brief and also describe review/export behavior.
See [docs/style-recipes.md](docs/style-recipes.md) before editing or adding one.

Exact prompt text and settings reproduce the request and its lineage. Gemini
does not expose a seed for these image calls, so they do not guarantee identical
pixels on a later run.

## CLI

The original direct-generation interface remains available:

```bash
nano-banana "minimal dashboard UI with dark theme"
nano-banana "quick square concept" --size 512 --aspect 1:1
nano-banana "edit this image" --ref input.png --output edited
nano-banana "high-detail asset" --model pro --size 2K
```

Options:

| Option | Default | Description |
| --- | --- | --- |
| `-o, --output` | timestamped | Filename without extension |
| `-s, --size` | `1K` | `512`, `1K`, `2K`, or `4K` |
| `-a, --aspect` | model default | Supported aspect ratio |
| `-m, --model` | `flash` | Alias or exact model ID |
| `-d, --dir` | current directory | Output directory |
| `-r, --ref` | none | Ordered reference; repeatable |
| `-t, --transparent` | off | Green-screen generation and local removal |
| `--api-key` | resolved | Explicit API-key override |
| `--costs` | none | Show legacy CLI cost history |

The direct CLI retains its historical Search-grounding behavior for models that
support it. Lite is validated as 1K-only and runs without Search; unsupported
known model/size/aspect combinations are rejected before key resolution. The
Workbench defaults Search off and records its value in each manifest.

### Models and pricing

| Alias | Exact model ID | Supported sizes | Approximate image output |
| --- | --- | --- | --- |
| `flash`, `nb2` | `gemini-3.1-flash-image` | 512, 1K, 2K, 4K | $0.045, $0.067, $0.101, $0.151 |
| `lite`, `nb2-lite` | `gemini-3.1-flash-lite-image` | 1K only | $0.0336 |
| `pro`, `nb-pro` | `gemini-3-pro-image` | 1K, 2K, 4K | $0.134, $0.134, $0.24 |

These are current standard paid-tier image-output equivalents. Prompt, text,
thinking, and Search usage can add cost. Verify the
[official pricing](https://ai.google.dev/gemini-api/docs/pricing) before relying
on the figures for a budget.

Nano Banana 2 Lite is cheaper at 1K, but it does not support 512 or Search
grounding. The 512 workbench default therefore uses
`gemini-3.1-flash-image`; model names are never inferred or silently aliased.

### Green-screen transparency

`--transparent` asks the model for a flat green background, detects the corner
key color with ImageMagick, removes it with FFmpeg `colorkey` and `despill`, then
trims transparent padding. This is local post-processing, not native transparent
provider output.

### API-key resolution

Both interfaces resolve the key in this order:

1. CLI `--api-key` when applicable.
2. `GEMINI_API_KEY` environment variable.
3. `.env` in the current directory.
4. `.env` in this repository.
5. `~/.nano-banana/.env`.

## Development

```bash
bun install
bun run check
```

`bun run check` verifies formatting, lint, TypeScript, tests, a Bun build, and a
built-workbench launch from outside the repository. Browser tests cover cookie
auth and selectable-card geometry. Tests force API-key discovery off and use
injected/mock generation; they do not spend API credits.

To inspect the UI without making provider calls:

```bash
NANO_BANANA_WORKBENCH_MOCK=1 nano-banana workbench
```

## License

MIT
