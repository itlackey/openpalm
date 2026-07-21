# Theming the OpenPalm UI

> **Status:** the "Today" sections describe the current UI (0.13.x). The
> `theme.css` workflow ships with **0.14.0 (#426)**.

OpenPalm's operator console is styled by a single design-token system called
**Stillness**. Every color in the UI resolves to a CSS custom property, so
theming is overriding a handful of token values in a plain CSS file. You edit
a file; the UI re-themes. There is no theme schema, no build step, and no
settings screen.

---

## How theming works today

### Where the tokens live

- `packages/ui-kit/src/lib/theme/tokens.css` — the Stillness `--s-*` tokens
  (colors, type scale, spacing, motion).
- `packages/ui/src/app.css` imports it and keeps only app-level layout CSS.

Components never hardcode palette colors; they consume `var(--s-…)`. Derived
tints (hover washes, subtle backgrounds, borders) are computed with
`color-mix()` from the anchor tokens, so changing one anchor cascades to all
of its tints automatically.

### Light / dark / system modes

- The mode toggle cycles **system → light → dark** and stores the preference
  in `localStorage` under `openpalm.theme`.
- A blocking pre-paint script in `app.html` stamps `data-theme="light"` or
  `data-theme="dark"` on `<html>` before first paint — no flash.
- Token blocks are currently keyed to that attribute (light:
  `:root, :root[data-theme='light'], :root[data-theme='day']`; dark:
  `:root[data-theme='dark'], :root[data-theme='night']`). Phase 1 of #426
  collapses this duplication: the anchors become single
  `light-dark(lightValue, darkValue)` declarations on `:root` inside a
  cascade `@layer`, resolved by `color-scheme` (which the pre-paint script
  already sets). The `data-theme` attribute remains for the few non-token
  selectors that use it.

### The color anchors

Eleven color tokens per mode define the entire palette:

| Token | Role | Light default | Dark default |
|---|---|---|---|
| `--s-paper` | Page background | `#E5E1D5` | `#15181B` |
| `--s-paper-deep` | Recessed surfaces | `#D9D5C8` | `#0F1214` |
| `--s-ink` | Primary text | `#26292B` | `#DAD6C9` |
| `--s-ink-2` | Secondary text | `#575B59` | `#989B91` |
| `--s-ink-3` | Tertiary text, labels | `#5D5C56` | `#85887F` |
| `--s-seal` | **Brand accent** | `#98420A` | `#DCC25C` |
| `--s-moss` | Success / positive | `#555C42` | `#8FA08C` |
| `--s-error` | Errors / destructive | `#AB301F` | `#D95F4E` |
| `--s-warning` | Caution | `#835D08` | `#E0B85A` |
| `--s-line` | Borders, dividers | `#6F6D66` | `#73766E` |
| `--s-line-soft` | Subtle borders | `#79756C` | `#666961` |

There are deliberately no hover/subtle/border variants: those derive from the
anchors via `color-mix()`, so a single `--s-seal` change re-tints every accent
surface.

### Guardrails

`packages/ui-kit/tests/theme-tokens.test.ts` pins the default palette to
WCAG AA (4.5:1 text, 3:1 borders, type floors, 4px spacing grid). If you
change the **default** theme in source, keep it green
(`cd packages/ui-kit && bun test`).

---

## Creating and applying a theme (0.14.0, #426)

Every install seeds an editable theme file:

```
~/.openpalm/config/ui/theme.css
```

It is yours — lifecycle never overwrites it — and because the built-in
tokens live in a cascade `@layer`, anything you set here wins, regardless of
selector or ordering. Each anchor takes both modes in one line via
`light-dark(lightValue, darkValue)`. Applying a theme is: open the file,
uncomment, change values, save, reload the browser.

### The seeded template

```css
/* OpenPalm UI theme — this file is yours; edit freely.
   Uncomment a token to override it. light-dark(a, b) sets the light
   and dark mode values in one line; a plain single value applies to
   both modes. Docs: docs/theming.md */

:root {
  /* --s-paper:      light-dark(#E5E1D5, #15181B); */
  /* --s-paper-deep: light-dark(#D9D5C8, #0F1214); */
  /* --s-ink:        light-dark(#26292B, #DAD6C9); */
  /* --s-ink-2:      light-dark(#575B59, #989B91); */
  /* --s-ink-3:      light-dark(#5D5C56, #85887F); */
  /* --s-seal:       light-dark(#98420A, #DCC25C); */
  /* --s-moss:       light-dark(#555C42, #8FA08C); */
  /* --s-error:      light-dark(#AB301F, #D95F4E); */
  /* --s-warning:    light-dark(#835D08, #E0B85A); */
  /* --s-line:       light-dark(#6F6D66, #73766E); */
  /* --s-line-soft:  light-dark(#79756C, #666961); */
}
```

### Example: re-color the brand accent

```css
:root {
  --s-seal: light-dark(#1D5C8F, #7FB4DC);
}
```

Save and reload. Buttons, active tabs, focus rings, the speaking waveform,
and every accent wash re-tint in both modes — they all derive from
`--s-seal`. Any CSS color syntax works (`oklch()`, named colors, …); use a
single value instead of `light-dark()` to apply it to both modes.

### Beyond the anchors

The file is real CSS — you *can* override any token or write arbitrary
rules. The 11 anchors are the supported, upgrade-stable surface; anything
beyond them may break as internal selectors evolve.

### Contrast

The shipped defaults are WCAG AA-verified; your overrides bypass those
tests. Keep `--s-ink`/`-2`/`-3` and the four status colors at ≥ 4.5:1
against both papers, and `--s-line` at ≥ 3:1. Any WCAG checker (e.g.
WebAIM's) works.

### Chat avatar

The chat surface ships with an animated **ensō presence mark** — idle
breathing, a pulsing bloom while thinking, ripples while listening, a
waveform while speaking. It draws with the theme's ink/seal tokens, so your
palette re-colors it automatically, and `prefers-reduced-motion` stills
every loop.

To replace it, drop **`avatar.png`** (or `avatar.webp` / `avatar.gif`) into
`~/.openpalm/config/ui/assets/`. Animated WebP/GIF plays as-is; reduced
motion is honored. Delete the file to return to the ensō. Raster formats
only, ≤ 1 MB.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing changed after editing | Hard-reload the browser; check the file is at `config/ui/theme.css` |
| Works in light mode but not dark | You set a single value where you wanted a pair — use `light-dark(lightValue, darkValue)` |
| Colors broken everywhere | Very old browser: the console requires `light-dark()` support (Chrome/Edge 123+, Firefox 120+, Safari 17.5+, all mid-2024) |
| Avatar not showing | Filename must be exactly `avatar.png`/`avatar.webp`/`avatar.gif` in `config/ui/assets/` |
| UI broken after aggressive custom CSS | Delete or empty `theme.css` — the UI always renders correctly without it |

### What theme.css does *not* control

- Product name and logo — out of scope for #426 (follow-up if needed).
- The **assistant terminal (TUI) theme** — OpenCode's own file, managed at
  `~/.openpalm/system/assistant/themes/openpalm.json`.
- The Electron shell (splash/tray) and desktop notifications.

---

## For contributors

- Token changes land in `packages/ui-kit`; keep `theme-tokens.test.ts` and
  `svelte-check` green.
- Consume `var(--s-*)` anchors or `color-mix()` tints — never hardcode a
  palette literal (hardcoded contrast-paired literals break operator
  overrides silently).
- The seeded template must stay in sync with the anchor list in `tokens.css`.
