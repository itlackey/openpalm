# Self-hosted fonts (H4, review 2026-07-10 §H4)

These woff2 files replace the `fonts.googleapis.com`/`fonts.gstatic.com`
`@import` that used to sit at the top of `src/app.css` — an installed PWA
that opens with no network at all previously fell back to system fonts
because the SW's app-shell precache never reaches cross-origin URLs. Both
families are the ones actually referenced by `packages/ui-kit`'s design
tokens (`--s-font-header`, `--s-font-display`/`--s-font-mono`); the app.html
`<link>` to Source Sans 3 / IBM Plex Mono that shipped alongside them was
dead weight (no `font-family` in this package ever names those families) and
was removed rather than also self-hosted.

Only the Latin/ASCII glyphs the app actually renders are included — neither
font family's full CJK-inclusive charset is needed for OpenPalm's UI text or
markdown, and shipping the full 20+ per-family glyph-range split the upstream
Google Fonts CSS returns by default would be enormous. Fetched with a `text=`
query restricting the subset to printable ASCII (`U+0020`–`U+007E`), which
collapses each family/weight down to a single woff2 file:

- `poor-story-400.woff2` — https://fonts.googleapis.com/css2?family=Poor+Story&text=<ascii>&display=swap
- `iosevka-charon-mono-{300,400,500,700}.woff2` — https://fonts.googleapis.com/css2?family=Iosevka+Charon+Mono:wght@300;400;500;700&text=<ascii>&display=swap

Only the upright (non-italic) faces are shipped — nothing in this package
sets `font-style: italic`; a `<em>`/`<i>` inside mono-formatted markdown gets
a browser-synthesized oblique instead of a dedicated italic face, an
acceptable degradation against shipping 2x the font weight.

Both families are licensed under the SIL Open Font License 1.1, which
permits redistribution (including subsetting) as part of a larger software
distribution.
