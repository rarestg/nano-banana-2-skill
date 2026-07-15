---
name: Nano Banana 2
description: A focused image-generation and selection workbench for production website assets.
colors:
  page-light: "#f4f4f5"
  surface-light: "#ffffff"
  surface-muted-light: "#fafafa"
  text-light: "#18181b"
  text-muted-light: "#52525b"
  line-light: "#d4d4d8"
  accent-light: "#0f766e"
  accent-soft-light: "#ccfbf1"
  danger-light: "#b91c1c"
  page-dark: "#09090b"
  surface-dark: "#18181b"
  surface-muted-dark: "#27272a"
  text-dark: "#fafafa"
  text-muted-dark: "#d4d4d8"
  line-dark: "#52525b"
  accent-dark: "#2dd4bf"
  accent-soft-dark: "#134e4a"
  danger-dark: "#f87171"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: "normal"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.1rem"
    fontWeight: 700
    lineHeight: "normal"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.86rem"
    fontWeight: 700
    lineHeight: "normal"
  caption:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0.06em"
rounded:
  small: "6px"
  control: "8px"
  card: "10px"
  panel: "12px"
  pill: "999px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "20px"
  space-6: "24px"
components:
  button-default:
    backgroundColor: "{colors.surface-muted-light}"
    textColor: "{colors.text-light}"
    rounded: "{rounded.control}"
    padding: "7px 11px"
    typography: "{typography.body}"
  button-primary:
    backgroundColor: "{colors.accent-light}"
    textColor: "{colors.surface-light}"
    rounded: "{rounded.control}"
    padding: "7px 11px"
    typography: "{typography.label}"
  input-default:
    backgroundColor: "{colors.surface-muted-light}"
    textColor: "{colors.text-light}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
    typography: "{typography.body}"
  status-pill:
    backgroundColor: "{colors.surface-muted-light}"
    textColor: "{colors.text-light}"
    rounded: "{rounded.pill}"
    padding: "5px 9px"
    typography: "{typography.caption}"
  recipe-card:
    backgroundColor: "{colors.surface-muted-light}"
    textColor: "{colors.text-light}"
    rounded: "{rounded.card}"
    padding: "12px"
---

# Design System: Nano Banana 2

## 1. Overview

**Creative North Star: "The Selection Bench"**

Nano Banana 2 is a compact production workspace: neutral surfaces hold the interface steady while generated images receive the attention. Controls are familiar, explicit, and close to the work they affect. The layout supports parallel review without making the surrounding chrome compete with the candidates.

The system is restrained rather than austere. Teal marks action, selection, and positive state; zinc neutrals carry structure in both light and dark themes. It explicitly rejects clunky workflows, hard-to-use controls, dated presentation, and unnecessary complexity.

**Key Characteristics:**

- Dense enough for repeated professional use, never cramped.
- Parallel comparison is the dominant layout behavior: every candidate in a run stays visible at once.
- Familiar controls with visible focus and unmistakable selected/Primary states.
- Desktop is the authoritative target; narrow-viewport breakpoints (1180 / 860 / 680px) degrade the multi-column layouts gracefully. Typography stays fixed at every width.
- Decoration is subordinate to the images and the decision.

## 2. Colors

Workbench Teal carries decisions and progress; a zinc scale supplies quiet structure across matched light and dark themes.

### Primary

- **Workbench Teal** (#0f766e light, #2dd4bf dark): Primary actions, focus outlines, selection borders, and positive notices.
- **Selection Wash** (#ccfbf1 light, #134e4a dark): Selected recipe backgrounds and other low-emphasis selected surfaces.

### Neutral

- **Bench Canvas** (#f4f4f5 light, #09090b dark): Application background.
- **Work Surface** (#ffffff light, #18181b dark): Main editor, history, and session panels.
- **Inset Surface** (#fafafa light, #27272a dark): Controls, cards, progress, and subordinate regions.
- **Primary Ink** (#18181b light, #fafafa dark): Main text and high-priority labels.
- **Secondary Ink** (#52525b light, #d4d4d8 dark): Hints, metadata, and supporting copy.
- **Bench Line** (#d4d4d8 light, #52525b dark): Dividers and structural boundaries.
- **Failure Red** (#b91c1c light, #f87171 dark): Errors, destructive actions, and failed states only.

### Named Rules

**The Decision Color Rule.** Teal means act, focus, select, or succeed. It is never ambient decoration.

**The Theme Parity Rule.** Every semantic role must retain the same meaning in light and dark themes; never swap roles merely to make a theme more colorful.

**The Non-Color State Rule.** Selection, failure, and progress always include text, shape, or icon reinforcement.

## 3. Typography

**Display Font:** Inter with the system sans-serif fallback stack
**Body Font:** Inter with the system sans-serif fallback stack

**Character:** One practical sans-serif family keeps labels, controls, metadata, and review content coherent. Hierarchy comes from weight and a compact fixed scale, not decorative font pairing.

### Hierarchy

- **Headline** (700, 1.25rem, normal): The workbench title; never used as oversized display type.
- **Title** (700, 1.1rem, normal): Primary panel and session headings.
- **Section Title** (700, 1rem, normal): Candidate groups and export records.
- **Body** (400, 1rem, 1.5): Longer prompt and explanatory content; prose stays within 75ch where practical.
- **Label** (700, 0.86rem, normal): Form labels, legends, and high-value compact UI text.
- **Caption** (700, 0.72rem, 0.06em): Status and session metadata only.

### Named Rules

**The Fixed Scale Rule.** Product typography uses the observed fixed rem scale. Never introduce fluid display headings into the workbench.

**The Metadata Rule.** Uppercase tracked text is reserved for compact machine-like metadata and states. Never use it as a decorative eyebrow above every section.

## 4. Elevation

The system is structurally flat. Page, panel, inset surface, and selected item are separated by tone and crisp Bench Line boundaries, not stacked shadows. In-flow panels — workspace, inspector, history, session — carry no ambient shadow; depth is read from background tone and borders. Shadow is spent only where an element genuinely floats above the page or must lift off imagery.

### Shadow Vocabulary

- **Overlay Drop** (0 8px 24px -12px rgb(0 0 0 / 35%)): Floating overlays that sit above the page, such as the spend-breakdown popover. Reserved for true pop-overs, never for in-flow panels.
- **Badge Lift** (0 1px 4px rgb(0 0 0 / 35%)): Small solid markers overlaid on imagery, such as the Primary badge, so they read against any generated content.
- **Selected Inset** (inset 0 0 0 1px current accent): Reinforces a selected recipe without raising it.
- **Primary Inset** (inset 0 0 0 2px current accent): Marks the Primary candidate's image with a teal inner boundary.

### Named Rules

**The Flat Panel Rule.** In-flow panels use tone and Bench Line boundaries, never an ambient shadow. Shadow is reserved for floating overlays and image badges.

**The One Depth Cue Rule.** A component gets one primary depth cue: tonal separation, a crisp border, or an inset accent. Never decorate an in-flow card with a wide soft shadow.

**The Images Stay Flat Rule.** Candidate imagery is shown at native geometry without decorative elevation; the only mark permitted on an image is the Primary badge.

## 5. Components

Components feel compact, explicit, and familiar. Every interactive primitive needs default, hover, focus-visible, active, disabled, loading, and error behavior where applicable.

### Buttons

- **Shape:** Compact curved control (8px radius).
- **Primary:** Workbench Teal with on-accent text (per the Theme Parity Rule, not literally white in dark), strong label weight, and compact padding.
- **Hover / Focus:** Hover reinforces the accent boundary; focus-visible uses a high-contrast 2px accent outline with separation from the control.
- **Icon:** Square icon-only buttons (e.g. the theme toggle) keep the shared control size with a centered glyph and an accessible label.
- **Secondary / Quiet:** Inset Surface with Primary Ink and a Bench Line boundary.
- **Danger:** Keeps the shared button structure and uses Failure Red for destructive meaning.
- **Disabled:** Remains legible at reduced emphasis and communicates the unavailable state through more than color.

### Chips

- **Style:** Status and flag pills use a 999px radius and compact padding. Status pills carry a Bench Line boundary on Inset Surface; the Primary flag is solid Workbench Teal on on-accent text, and the Exported flag is an outline pill.
- **State:** Chips report configuration or status; they are not decorative tags.

### Cards / Containers

- **Corner Style:** Controls and candidate previews use the 8px control radius, cards (recipe, inspector, popover) use 10px, and the session panel uses 12px.
- **Background:** Work Surface for major regions; Inset Surface for options and controls. Candidate previews sit directly on the sheet with no card container.
- **Shadow Strategy:** No panel uses ambient elevation; depth comes from tone and boundaries. See §4.
- **Border:** Bench Line at rest; Workbench Teal plus a selected/Primary inset for active choices.

### Inputs / Fields

- **Style:** Bench Line boundary, Inset Surface fill, 8px radius, and 9px 11px padding.
- **Focus:** A 2px Workbench Teal outline with 2px offset.
- **Error / Disabled:** Failure Red is reserved for invalid state; disabled controls stay readable and non-interactive.

### Navigation

- **Top bar:** A compact sticky utility header holding the brand, key/mock status, an **all stored runs spend tracker**, and an icon **theme toggle** (sun/moon). Spend uses generated-image counts, never configured call counts. Exact totals, conservative upper bounds, and unknown costs remain separate; unavailable cost is never rendered as `$0`, while a completed run with no submitted calls is explicitly `$0.00`. The breakdown dismisses on click-away or Escape.
- **History:** A left rail, **collapsed by default**, opened from a toggle into an accessible drawer. The current session is marked with `aria-current`; items truncate long subjects and retain a readable status/date line.
- **Typography:** Navigation labels use the same sans-serif scale as controls.

### Recipe Selector

Recipe options are selectable cards with a visible native checkbox relationship. Selection uses both the teal boundary/wash and explicit “Included” text. The four-column comparison grid reduces to fewer columns at the narrow-viewport breakpoints; desktop shows all four.

### Contact Sheet

Candidates render as a compact contact-sheet grid grouped by style recipe. Columns auto-fit (min ~180px) and the sheet never scrolls horizontally — every candidate in a run stays visible at once for parallel comparison. Each card preserves square preview geometry and shows its variant identity; status appears once and quietly, and only when it is not a plain success.

**Candidate states** are visually distinct and never color-only:

- **Focused:** A teal outline ring around the previewed image; drives the inspector. Exactly one at a time.
- **Primary:** A solid teal **Primary** pill, a teal check **badge on the image**, and a teal inset border. Primary is the run's unmistakable chosen asset; it is optional and does **not** control exports.
- **Exported:** An outline **Exported** pill; a candidate may be exported any number of times.
- **Selected for export:** A native checkbox per card that feeds the bulk export tray.

### Inspector

A persistent right-hand panel (~336px, sticky) shows the focused candidate at large size with its **Style → Subject → Variant** identity path, status and cost, native-size previews where relevant, **Set as Primary / Clear Primary** controls, and a single **Export candidate** action. It is the one place the full identity hierarchy is stated.

### Export Tray

Bulk export is a tray at the top of the contact-sheet column that appears only when one or more candidates are selected (`Export selected (N)`). It is scoped to the sheet's checklist, kept separate from the inspector's single-candidate export, and never changes Primary.

### Run Summary

Once a run starts, the setup form collapses into a compact, editable run-summary bar (styles, subject, settings, and an **Edit setup** control), keeping the configuration legible without competing with the candidates.

## 6. Do's and Don'ts

### Do:

- **Do** keep the fastest path from prompt to selected export visible in one workspace.
- **Do** use Workbench Teal only for action, focus, selection/Primary, and positive state.
- **Do** keep every candidate in a run visible at once for parallel comparison; desktop is the authoritative target.
- **Do** keep keyboard focus visible and status/Primary meaning independent of color.
- **Do** use the established radius vocabulary according to component scale.

### Don't:

- **Don't** create clunky workflows or hide the primary generation and selection actions.
- **Don't** make controls hard to use through novel affordances or ambiguous states.
- **Don't** introduce dated presentation, ornamental chrome, or unnecessary complexity.
- **Don't** repeat uppercase eyebrow labels as section scaffolding.
- **Don't** use decorative gradients, glassmorphism, oversized hero metrics, or identical card grids.
- **Don't** pair a small component's crisp border with a wide soft shadow.
- **Don't** let interface decoration compete with generated imagery.
