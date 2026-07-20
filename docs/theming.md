# Theming & Branding the OpenPalm UI

> **Status:** the "Today" sections describe the current UI (0.13.x). The
> "Creating and applying a theme" workflow ships with the branding override
> feature planned for **0.14.0 (#426)** — the schema below is the design of
> record for that issue and may evolve until it ships.

OpenPalm's operator console (chat + host dashboard) is styled by a single
design-token system called **Stillness**. Every color, font, spacing step, and
motion curve in the UI resolves to a CSS custom property, so theming is a
matter of overriding a small set of token values — not editing components.

---

## How theming works today

### Where the tokens live

The token vocabulary is defined once, in the shared UI kit:

- `packages/ui-kit/src/lib/theme/tokens.css` — the Stillness `--s-*` tokens
  (colors, type scale, spacing, motion) plus the `wiz-*` wizard vocabulary.
- `packages/ui/src/app.css` imports it (`@import '@openpalm/ui-kit/theme/tokens.css'`)
  and keeps only app-level layout/utility CSS.

Components never hardcode palette colors; they consume `var(--s-…)`. Derived
tints (hover washes, subtle backgrounds, borders) are computed with
`color-mix()` from the anchor tokens, so changing one anchor cascades to all
of its tints automatically.

### Light / dark / system modes

- The mode toggle (in the navbar) cycles **system → light → dark** and stores
  the preference in `localStorage` under `openpalm.theme`.
- A blocking pre-paint script in `app.html` resolves the preference before
  first paint and stamps `data-theme="light"` or `data-theme="dark"` on
  `<html>` — so there is no flash of the wrong mode.
- Token blocks are keyed to that attribute:
  - light: `:root, :root[data-theme='light'], :root[data-theme='day']`
  - dark: `:root[data-theme='dark'], :root[data-theme='night']`

### The color anchors

Eleven color tokens per mode define the entire palette. These are the values
a theme overrides:

| Anchor | Token | Role | Light default | Dark default |
|---|---|---|---|---|
| `paper` | `--s-paper` | Page background | `#E5E1D5` | `#15181B` |
| `paperDeep` | `--s-paper-deep` | Recessed surfaces (asides, wells) | `#D9D5C8` | `#0F1214` |
| `ink` | `--s-ink` | Primary text | `#26292B` | `#DAD6C9` |
| `ink2` | `--s-ink-2` | Secondary text | `#575B59` | `#989B91` |
| `ink3` | `--s-ink-3` | Tertiary text, labels | `#5D5C56` | `#85887F` |
| `seal` | `--s-seal` | **Brand accent** — primary actions, active states | `#98420A` | `#DCC25C` |
| `moss` | `--s-moss` | Success / positive | `#555C42` | `#8FA08C` |
| `error` | `--s-error` | Errors / destructive | `#AB301F` | `#D95F4E` |
| `warning` | `--s-warning` | Caution | `#835D08` | `#E0B85A` |
| `line` | `--s-line` | Borders, dividers | `#6F6D66` | `#73766E` |
| `lineSoft` | `--s-line-soft` | Subtle borders | `#79756C` | `#666961` |

There are deliberately **no hover/subtle/border variants** to override: those
are derived from the anchors via `color-mix()` (e.g. an 8% seal wash for
accent backgrounds), so a single `seal` change re-tints every accent surface
in the UI.

### Guardrails

`packages/ui-kit/tests/theme-tokens.test.ts` pins the default palette to
WCAG AA: 4.5:1 for text tokens on both papers, 3:1 for border tokens, plus
type-size floors and the 4px spacing grid. If you change the **default** theme
in source, keep that suite green (`cd packages/ui-kit && bun test`).

### Changing the default theme today (source builds)

Until the 0.14.0 runtime override ships, retheming means editing source:

1. Edit the anchor values in `packages/ui-kit/src/lib/theme/tokens.css`
   (both the light and dark blocks).
2. Run `cd packages/ui-kit && bun test && bun run check` — the contrast suite
   tells you immediately if a value breaks AA.
3. Rebuild the UI (`bun run ui:build`).

---

## Creating and applying a theme (0.14.0, #426)

Once the branding override ships, themes are a single operator-owned JSON
file — no rebuild, no source edits.

### The theme file

`~/.openpalm/config/ui/branding.json` (seeded with defaults on install;
user-owned — lifecycle never overwrites it):

```jsonc
{
  "version": 1,
  "name": null,                            // string → replaces "OpenPalm" everywhere; null → default
  "logo": { "light": null, "dark": null }, // filenames under config/ui/assets/; null → built-in logo
  "palette": {
    "light": {},                           // any subset of the 11 anchors, hex only
    "dark": {}
  },
  "avatar": null                           // filename under config/ui/assets/; null → animated ensō
}
```

Rules:

- Palette keys are the camelCase anchor names from the table above
  (`paper`, `paperDeep`, `ink`, `ink2`, `ink3`, `seal`, `moss`, `error`,
  `warning`, `line`, `lineSoft`).
- Values must be 6-digit hex (`#RRGGBB`). Anything else — shorthand hex,
  `rgb()`/`oklch()`, CSS keywords, or anything containing punctuation — is
  rejected and the default is used for that key. This is a security boundary
  (the values are emitted into a style block), not a formatting preference.
- Every key is optional. Override one anchor or all eleven; light and dark
  are independent.
- Unknown keys are ignored (forward-compatible) and logged.

### Walkthrough: a minimal brand re-color

Change only the accent, in both modes:

```jsonc
{
  "version": 1,
  "palette": {
    "light": { "seal": "#1D5C8F" },
    "dark":  { "seal": "#7FB4DC" }
  }
}
```

Save the file and reload the UI — the server picks up edits within a few
seconds (no restart). Buttons, active tabs, focus rings, the speaking
waveform, and every accent wash re-tint, because they all derive from
`--s-seal`.

### Walkthrough: a full theme

A complete "slate & amber" theme:

```jsonc
{
  "version": 1,
  "name": "Ops Console",
  "palette": {
    "light": {
      "paper": "#ECEEF1", "paperDeep": "#DFE3E8",
      "ink": "#1F2429", "ink2": "#4C555E", "ink3": "#5D6772",
      "seal": "#B26A00", "moss": "#3E6B4F",
      "error": "#A8321F", "warning": "#8A6400",
      "line": "#6C737A", "lineSoft": "#7E858C"
    },
    "dark": {
      "paper": "#14171A", "paperDeep": "#0E1114",
      "ink": "#D7DBDF", "ink2": "#97A0A8", "ink3": "#828B93",
      "seal": "#E8A94E", "moss": "#8CAB94",
      "error": "#D96A55", "warning": "#D9B45C",
      "line": "#6E767D", "lineSoft": "#61686F"
    }
  }
}
```

### Contrast: your responsibility once you override

The shipped defaults are WCAG AA-verified; your overrides bypass those tests.
Keep these pairs readable:

- `ink` / `ink2` / `ink3` against **both** `paper` and `paperDeep` — ≥ 4.5:1.
- `seal`, `moss`, `error`, `warning` against both papers — ≥ 4.5:1 (they are
  used as text/icon colors, not just fills).
- `line` against both papers — ≥ 3:1.

The Appearance settings tab shows a contrast warning per anchor as you edit;
any WCAG checker (e.g. WebAIM's) works for offline authoring. Dark-mode tip:
don't use pure `#000000`/`#FFFFFF` — keep at least one intermediate surface
(`paperDeep`) distinct from `paper`.

### Logo

Drop raster files into `~/.openpalm/config/ui/assets/` and name them:

```jsonc
{ "logo": { "light": "logo.png", "dark": "logo-dark.png" } }
```

- Formats: PNG, GIF, WebP. ≤ 1 MB. **No SVG uploads** (XSS surface) and no
  remote URLs — files are served same-origin from your config directory.
- Why a light/dark pair: the built-in logo is an inline SVG that inherits the
  text color and adapts to the mode automatically; a raster file cannot, so
  you supply one per mode (either may be omitted to keep the built-in mark).
- Missing or invalid files fall back to the built-in logo — a typo never
  breaks the UI.

### Chat avatar

The chat surface ships with an animated **ensō presence mark** as the
assistant avatar. It is state-reactive:

- **idle** — slow breathing
- **thinking** (assistant is working) — dimmed mark with a pulsing accent bloom
- **listening** (voice input) — ripples gathering inward
- **speaking** (voice output) — a five-bar waveform

It uses the brand mark and the theme's `ink`/`seal` tokens, so palette
overrides re-color it automatically. `prefers-reduced-motion` stills every
loop.

To replace it with your own image:

```jsonc
{ "avatar": "avatar.webp" }
```

Same rules as logos (PNG/GIF/WebP under `config/ui/assets/`, ≤ 1 MB). An
animated GIF/WebP plays as-is; the state-driven motion classes still apply
gentle scale/opacity treatment around it, and reduced-motion is honored.
Set `"avatar": null` to return to the ensō.

### Applying and troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing changed after editing the file | JSON syntax error — check the server log; the file is parsed fail-closed (invalid file ⇒ defaults). Validate with `jq . branding.json` |
| One color ignored, others applied | That value failed the `#RRGGBB` check (shorthand hex and `oklch()` are not accepted) |
| Logo/avatar not showing | Filename in JSON must exactly match a file in `config/ui/assets/`; only PNG/GIF/WebP are served; check size ≤ 1 MB |
| Colors flash on load | Should never happen — the override is injected server-side before paint. If you see a flash, file a bug |
| Theme works in light mode but not dark | The two modes are independent — add the anchor under `palette.dark` too |

### What branding.json does *not* theme

- The **assistant terminal (TUI) theme** — that's OpenCode's own theme file,
  managed at `~/.openpalm/system/assistant/themes/openpalm.json`
  (lifecycle-overwritten; separate system).
- The Electron shell (splash screen, tray icon) and desktop notification
  titles — tracked separately.
- Fonts, spacing, motion — the Stillness type/spacing/motion tokens are not
  operator-overridable (bounded palette by design).

---

## For contributors

- Token changes land in `packages/ui-kit` (raw-source package, no build step);
  keep `theme-tokens.test.ts` and `svelte-check` green.
- New components must consume `var(--s-*)` anchors or `color-mix()` tints of
  them — never hardcode a palette literal (hardcoded contrast-paired literals
  break operator overrides silently).
- The UI design rubric (`docs/technical/ui-design-rubric.md`) remains the
  approval gate for visual changes; note that "brand accent" is
  operator-overridable once #426 ships.
