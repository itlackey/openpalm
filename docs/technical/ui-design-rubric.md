# OpenPalm Operator UI — Web Design Quality Rubric

**Version 1.0 — the REQUIRED approval gate for every UI overhaul round (#439).**

A round ships only when every category is PASS. No partial passes, no "mostly", no exceptions. Each criterion must be verifiable from a screenshot or a DevTools inspection of that screenshot's rendered state. Each round supplies screenshots at 320 / 768 / 1280px for every changed surface (plus dark-mode for Categories 4 & 10), reviewed by a critical design expert who marks every criterion ✓ / ✗ / N/A and signs off before merge.

## Scoring
- **APPROVED** = all 10 categories PASS. **REJECTED** = any category FAIL. A category is PASS only when every criterion is met. N/A is allowed only when the feature is genuinely absent from the reviewed view.

---

## 1 — Visual hierarchy
- One h1 per view, largest text, ≥1 type-step above h2/h3.
- At most ONE primary (filled) action per view; secondary = ghost/outline; tertiary = text link.
- The 3 most important items are hit first in a Z/F scan without backtracking.
- Chrome (nav/sidebar/dividers) is subordinate to content (lighter/smaller).
- Active admin tab differs by **more than color** (weight/underline/fill).
- FAIL: ≥2 filled primaries in one view; no dominant element; tabs differ by color alone.

## 2 — Spacing / alignment / density
- All spacing on a 4/8px base (no 5/7/13px in computed styles).
- Intra-group gap < inter-group gap (≥2× ratio).
- No content within **8px** of a viewport edge at 320/768/1280.
- Grids align; card tops align; row heights consistent (≤4px variance for same content).
- Labels flush to inputs (above or inline), unambiguous.
- FAIL: clipped/obscured content; obvious sibling misalignment; random spacing.

## 3 — Typography
- Body ≥14px; secondary ≥12px; **nothing <12px**.
- ≤5 distinct font sizes total, each with a role.
- Headers are title/sentence case; all-caps only for ≤12-char badges with ≥0.05em tracking.
- Paragraph line length 50–80 chars (≤800px column).
- Body/label weight 400–500; bold 600–700 for headings/emphasis only; no ≤300 under 18px.
- FAIL: text <12px; >5 sizes; all-caps headings/body; weight ≤300 small text.

## 4 — Color & brand usage
- Brand **orange = exactly ONE role** (primary action OR active state — not both on a screen).
- Semantic colors consistent: destructive/error = red, success = green, warning = amber; orange never = error/warning.
- Clear surface layering (base → card → elevated) in light AND dark.
- ≤5 named hues in chrome.
- Dark theme: no pure #000/#fff as the only pair; ≥1 intermediate surface.
- FAIL: orange in two roles on one screen; error in orange; dark = pure #000/#fff only.

## 5 — Contrast & accessibility (WCAG AA)
- Text ≥18px/bold≥14px → ≥3:1; all other text → ≥4.5:1 (against its real background).
- Every icon-only button has a tooltip or `aria-label` (verify in DevTools).
- Interactive targets ≥**44×44px** (inline body links exempt).
- Visible focus ring on every control (≥2px, ≥3:1); no `outline:none` without a custom equivalent.
- Disabled controls visually distinct (≤60% opacity) and non-interactive.
- Inputs have visible labels (placeholder-only is FAIL).
- FAIL: any contrast miss; unlabeled icon button; <44px target; removed focus ring.

## 6 — Component consistency
- Same-class buttons identical (height/radius/size/weight) everywhere (≤2px height variance).
- One (or two documented) card radius value(s).
- Status badges share height/padding/size/radius; only color+label differ.
- Inputs share height/border/radius/focus across pages.
- One icon family; no filled+outline mixing in a context; sizes from {16,20,24}.
- FAIL: equivalent buttons differing in radius/height >2px; badge radius differs by page; mixed icon families; inconsistent input focus.

## 7 — Affordances & states
- Every control has a distinct hover state (not cursor alone).
- Selected/active differs by ≥2 properties (color+weight/border/fill).
- Empty states: icon + 1–2 sentences + one action.
- Loading: skeleton/spinner in the loading area (not blank/frozen).
- Errors: human message + cause + recovery, in error color; no raw stack traces.
- Destructive actions require confirmation (inline or modal); no one-click destroy.
- FAIL: no hover; blank empty/loading state; raw stack trace; one-click destroy.

## 8 — Responsive (320–1440px)
- 320px: no horizontal scrollbar, no clipping/overlap, all content reachable by vertical scroll.
- 320px: tab bar wraps cleanly / collapses / scrolls with a visible indicator; no mid-word truncation without ellipsis.
- 768px: a real intermediate layout (not a snap between mobile and desktop).
- Tables scroll within a container or reflow to cards; no clipped columns.
- Targets stay ≥44px at all widths.
- The Advanced iframe stays within the viewport at all widths.
- FAIL: body horizontal scrollbar ≥320px; clipped content at 320px; mid-word tab truncation; overflowing table.

## 9 — Content clarity
- Cron never raw without a human translation ("Every 6 hours").
- Container/image/service IDs have a human display name (raw = secondary/tooltip).
- Filesystem paths carry a contextual label.
- Status as human words, not raw enums (`running`→"Running").
- Confirmations/success are complete sentences (not "OK"/"200").
- Technical inputs have format hints/examples.
- FAIL: raw cron as primary label; raw container name only; raw enum status; "OK"-only confirm.

## 10 — Overall polish
- No placeholder/TODO/debug/test text in production views.
- No visually broken elements (overlap, bleed, z-index, broken images).
- Micro-interactions ≤300ms, view transitions ≤500ms; no infinite animation on static content.
- Light AND dark fully themed (no unthemed surfaces).
- Icons/illustrations sharp at 1x/2x (SVG where appropriate).
- Chat and Admin feel like one product (shared type/spacing/color/components).
- FAIL: placeholder/debug text; broken element; unthemed dark surfaces; Chat vs Admin component mismatch.
