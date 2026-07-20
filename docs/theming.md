# Theming & Branding the OpenPalm UI

> **Status:** the "Today" sections describe the current UI (0.13.x). The
> `theme.css` workflow ships with the branding feature planned for
> **0.14.0 (#426)** — it is the design of record for that issue.

OpenPalm's operator console (chat + host dashboard) is styled by a single
design-token system called **Stillness**. Every color in the UI resolves to a
CSS custom property, so theming is overriding a handful of token values in a
plain CSS file — no build step, no JSON schema, no admin screens. You edit a
file; the UI re-themes.

---

## How theming works today

### Where the tokens live

The token vocabulary is defined once, in the shared UI kit:

- `packages/ui-kit/src/lib/theme/tokens.css` — the Stillness `--s-*` tokens
  (colors, type scale, spacing, motion) plus the `wiz-*` wizard vocabulary.
- `packages/ui/src/app.css` imports it and keeps only app-level layout CSS.

Components never hardcode palette colors; they consume `var(--s-…)`. Derived
tints (hover washes, subtle backgrounds, borders) are computed with
`color-mix()` from the anchor tokens, so changing one anchor cascades to all
of its tints automatically.

### Light / dark / system modes

- The mode toggle (in the navbar) cycles **system → light → dark** and stores
  the preference in `localStorage` under `openpalm.theme`.
- A blocking pre-paint script in `app.html` resolves the preference before
  first paint and stamps `data-theme="light"` or `data-theme="dark"` on
  `<html>` — no flash of the wrong mode.
- Token blocks are keyed to that attribute:
  - light: `:root, :root[data-theme='light'], :root[data-theme='day']`
  - dark: `:root[data-theme='dark'], :root[data-theme='night']`

### The color anchors

Eleven color tokens per mode define the entire palette. These are the values
a theme overrides:

| Token | Role | Light default | Dark default |
|---|---|---|---|
| `--s-paper` | Page background | `#E5E1D5` | `#15181B` |
| `--s-paper-deep` | Recessed surfaces (asides, wells) | `#D9D5C8` | `#0F1214` |
| `--s-ink` | Primary text | `#26292B` | `#DAD6C9` |
| `--s-ink-2` | Secondary text | `#575B59` | `#989B91` |
| `--s-ink-3` | Tertiary text, labels | `#5D5C56` | `#85887F` |
| `--s-seal` | **Brand accent** — primary actions, active states | `#98420A` | `#DCC25C` |
| `--s-moss` | Success / positive | `#555C42` | `#8FA08C` |
| `--s-error` | Errors / destructive | `#AB301F` | `#D95F4E` |
| `--s-warning` | Caution | `#835D08` | `#E0B85A` |
| `--s-line` | Borders, dividers | `#6F6D66` | `#73766E` |
| `--s-line-soft` | Subtle borders | `#79756C` | `#666961` |

There are deliberately **no hover/subtle/border variants** to override: those
derive from the anchors via `color-mix()` (e.g. an 8% seal wash for accent
backgrounds), so a single `--s-seal` change re-tints every accent surface.

### Guardrails

`packages/ui-kit/tests/theme-tokens.test.ts` pins the default palette to
WCAG AA: 4.5:1 for text tokens on both papers, 3:1 for border tokens, plus
type-size floors and the 4px spacing grid. If you change the **default** theme
in source, keep that suite green (`cd packages/ui-kit && bun test`).

---

## Creating and applying a theme (0.14.0, #426)

Every install seeds an editable theme file:

```
~/.openpalm/config/ui/theme.css
```

It is user-owned — lifecycle never overwrites it — and it is loaded by every
page **after** the built-in stylesheet, so anything you set there wins. The
file ships with the full anchor list commented out, in the correct light/dark
blocks, so applying a theme is: open the file, uncomment, change values, save,
reload the browser. No restart, no rebuild.

### The seeded template

```css
/* OpenPalm UI theme — edit freely; this file is yours.
   Uncomment a token to override it. Keep values inside these two blocks:
   the selectors must match the built-in theme's blocks so your values
   apply in the right mode. Full docs: docs/theming.md */

:root,
:root[data-theme='light'],
:root[data-theme='day'] {
  /* --s-paper:      #E5E1D5; */
  /* --s-paper-deep: #D9D5C8; */
  /* --s-ink:        #26292B; */
  /* --s-ink-2:      #575B59; */
  /* --s-ink-3:      #5D5C56; */
  /* --s-seal:       #98420A; */
  /* --s-moss:       #555C42; */
  /* --s-error:      #AB301F; */
  /* --s-warning:    #835D08; */
  /* --s-line:       #6F6D66; */
  /* --s-line-soft:  #79756C; */
}

:root[data-theme='dark'],
:root[data-theme='night'] {
  /* --s-paper:      #15181B; */
  /* --s-paper-deep: #0F1214; */
  /* --s-ink:        #DAD6C9; */
  /* --s-ink-2:      #989B91; */
  /* --s-ink-3:      #85887F; */
  /* --s-seal:       #DCC25C; */
  /* --s-moss:       #8FA08C; */
  /* --s-error:      #D95F4E; */
  /* --s-warning:    #E0B85A; */
  /* --s-line:       #73766E; */
  /* --s-line-soft:  #666961; */
}
```

### Walkthrough: re-color the brand accent

Uncomment `--s-seal` in both blocks and change the values:

```css
:root,
:root[data-theme='light'],
:root[data-theme='day'] {
  --s-seal: #1D5C8F;
}

:root[data-theme='dark'],
:root[data-theme='night'] {
  --s-seal: #7FB4DC;
}
```

Save and reload. Buttons, active tabs, focus rings, the speaking waveform,
and every accent wash re-tint — they all derive from `--s-seal`.

### Beyond the anchors

The file is real CSS on your own machine — you *can* override any token
(fonts, spacing, motion) or write arbitrary rules. The 11 color anchors are
the supported surface: they are stable across releases and everything derives
from them. Anything beyond the anchors may break on upgrade as internal
selectors and tokens evolve — keep a backup and expect to maintain it.

### Contrast: your responsibility once you override

The shipped defaults are WCAG AA-verified; your overrides bypass those tests.
Keep these pairs readable:

- `--s-ink` / `-2` / `-3` against **both** papers — ≥ 4.5:1.
- `--s-seal`, `--s-moss`, `--s-error`, `--s-warning` against both papers —
  ≥ 4.5:1 (they are used as text/icon colors, not just fills).
- `--s-line` against both papers — ≥ 3:1.

Any WCAG checker (e.g. WebAIM's) works. Dark-mode tip: don't use pure
`#000000`/`#FFFFFF` — keep `--s-paper-deep` visibly distinct from `--s-paper`.

### Product name and logo

- **Name**: set `OP_UI_BRAND_NAME` in `~/.openpalm/knowledge/env/stack.env`
  to replace the "OpenPalm" strings (navbar, login, setup, page titles).
  Unset → default.
- **Logo**: drop raster files into `~/.openpalm/config/ui/assets/` using the
  conventional names `logo.png` and `logo-dark.png` (`.webp`/`.gif` also
  accepted). If present they replace the built-in mark in the matching mode;
  absent files fall back to the built-in inline SVG (which follows your theme
  colors automatically — a raster logo cannot, which is why there is a
  per-mode pair).
- Formats: PNG, GIF, WebP only, ≤ 1 MB. No SVG files (they can carry active
  content) and no remote URLs — assets are served same-origin from your
  config directory.

### Chat avatar

The chat surface ships with an animated **ensō presence mark** as the
assistant avatar. It is state-reactive — idle breathing, a pulsing bloom
while the assistant is thinking, inward ripples while listening, a five-bar
waveform while speaking — and it draws with the theme's ink/seal tokens, so
your palette re-colors it automatically. `prefers-reduced-motion` stills
every loop.

To replace it with your own image, drop `avatar.png` (or `.webp`/`.gif`)
into `~/.openpalm/config/ui/assets/`. Animated GIF/WebP plays as-is; the
state-driven motion classes still apply gentle scale/opacity treatment, and
reduced-motion is honored. Delete the file to return to the ensō.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing changed after editing | Hard-reload the browser (the theme file is served with revalidation, but the tab may hold a cached copy); check the file is at `config/ui/theme.css` |
| Override works in light mode but not dark | The two blocks are independent — set the token inside the dark block too |
| Override ignored entirely | Values placed outside the two selector blocks (e.g. a bare `:root { }`) lose to the built-in mode blocks — keep overrides inside the seeded selectors |
| Logo/avatar not showing | Check the conventional filename (`logo.png`, `logo-dark.png`, `avatar.png`/`.webp`/`.gif`), the location (`config/ui/assets/`), format (PNG/GIF/WebP), and size ≤ 1 MB |
| UI broken after aggressive custom CSS | Delete or empty `theme.css` — the UI always renders correctly without it |

### What theme.css does *not* control

- The **assistant terminal (TUI) theme** — that's OpenCode's own theme file,
  managed at `~/.openpalm/system/assistant/themes/openpalm.json`
  (lifecycle-overwritten; separate system).
- The Electron shell (splash screen, tray icon) and desktop notification
  titles — tracked separately.

---

## For contributors

- Token changes land in `packages/ui-kit` (raw-source package, no build
  step); keep `theme-tokens.test.ts` and `svelte-check` green.
- New components must consume `var(--s-*)` anchors or `color-mix()` tints of
  them — never hardcode a palette literal (hardcoded contrast-paired literals
  break operator overrides silently).
- The seeded template above must stay in sync with the anchor list in
  `tokens.css` — the token contract test covers both.
- The UI design rubric (`docs/technical/ui-design-rubric.md`) remains the
  approval gate for visual changes; note that the brand accent is
  operator-overridable once #426 ships.
