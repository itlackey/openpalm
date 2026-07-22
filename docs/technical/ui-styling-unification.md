# UI Styling Unification — drift inventory & refactor plan

> **Status: plan (2026-07-20).** Written against `main` @ `07890f4`
> (0.13.0-beta.8). Companion to issue #426 (rev 5), which establishes the
> theming foundation (`light-dark()` + `@layer` tokens, operator
> `theme.css`). This document inventories every place the app drifts from
> that architecture and lays out the refactor to one unified styling system.
>
> **Provenance:** produced by a 7-surface parallel code sweep (setup wizard,
> host dashboard, settings/voice, chat, entry surfaces, ui-kit, global CSS),
> each surface independently re-verified by an adversarial pass that opened
> every cited file/line, plus manual spot-checks. 119 findings were filed;
> 117 confirmed, 2 refuted on citation accuracy (premises noted below), and
> 9 additional items surfaced by the verifiers. Citation corrections from
> verification are folded into this document.

---

## 1. The target architecture

One styling system, four layers:

1. **Tokens** — `packages/ui-kit/src/lib/theme/tokens.css` is the single
   source of truth: 11 color anchors per mode (migrating to single
   `light-dark()` declarations inside `@layer theme-tokens`, #426 phase 1),
   plus type (`--s-type-*`), fonts (`--s-font-*`), spacing (`--s-sp-*`,
   4px grid), motion (`--s-t-*`, `--s-ease*`), and layout tokens.
2. **Derivation** — every tint/wash/hover derives from an anchor via
   `color-mix()` (or `filter: brightness()`); no raw palette literals in
   component styles, ever. This is what makes operator theming work: one
   `--s-seal` override must reach every accent surface.
3. **Shared components & utilities** — presentational components live once
   in `@openpalm/ui-kit`; genuinely global utility classes (`.btn*`,
   `.badge*`, `.feedback*`, form primitives) are defined once and consumed
   everywhere; pages never re-implement them.
4. **Scoped component styles** — everything page/component-specific lives in
   that component's own `<style>` block, consuming layers 1–3.
   `app.css` holds only global concerns (reset, base, scrollbars, shared
   utilities).

Conventions: no `[data-theme]` selectors in components (mode-dependence
belongs in tokens); `prefers-reduced-motion` covers every loop/entrance
animation; Svelte 5 runes with `$effect` treated as a bug unless justified;
no `{@html}` with non-static content.

## 2. State of the system (verified)

| Surface | Health | Dominant drift |
|---|---|---|
| Entry (login/attention/layout/app.html) | **Clean** | app.html theme-color literals + dead font load |
| Settings/voice (connections, voice, device chrome) | Good | 2 contrast literals; `.alert`/`.btn-danger`/pill-toggle duplicates; `border-radius: 2px` ×13 |
| Host dashboard (~20 admin/akm components) | Good | 3 hand-rolled white-on-seal checkboxes; underline input copied ~8×; badge concept reinvented ×5; an 8-property `!important` fight |
| ui-kit | Good | Drawer scrim literal; wiz-* px/font scales parallel to tokens; 3 components depend on app.css globals |
| Chat (chat/advanced routes + 15 components) | Fair | `.s-moon` `[data-theme]` branch; nav heights 64/112/144px copied ×4 files; `0.75/0.875rem` and `120ms` literals pervasive; 5 duplicated mini-patterns |
| Setup wizard (10 step components) | **Poor** | 9 invented-hue washes incl. one rgb triplet pasted ×3 files; 2 hand-rolled RadioRow clones; third on-seal literal; only surface with zero reduced-motion handling |
| Global CSS (`app.css`, 1704 lines) | **Poor** | ~500–600 lines confirmed-dead wizard CSS; ~350 lines live-but-misplaced; ~250-line unconsumed "Universal Form System" |

Also verified: **`--nav-height` and the four `--toggle-*` tokens have zero
consumers anywhere** (components hardcode the same values); the `.wiz-*`
vocabulary is ~⅓ dead (14 of 39 selectors never referenced); `$effect`
appears exactly once (root `+layout.svelte`, with an inline justification —
compliant); no inline `style=` carries colors anywhere.

## 3. Decisions

- **D1 — on-accent text is `var(--s-paper)`.** `app.css`'s `.btn-primary`
  already does this (`color: var(--s-paper); background: var(--s-seal)`),
  and it self-adjusts in both modes and under operator overrides. The four
  hardcoded on-seal literals (`#1f1d18`, `#1a0e00` ×2, `white`) and the
  three white-on-moss checkmarks all become `var(--s-paper)`. (A dedicated
  `--s-on-seal` token can come later if contrast tuning demands it.)
- **D2 — status semantics always use status anchors.** Error/warning/success
  UI uses `--s-error`/`--s-warning`/`--s-moss` — never `--s-seal` standing
  in for danger (fixes the `.alert` family, local `.btn-danger` shadow, the
  rgb(242,92,92) triad, `.deploy-bar-fill` ambers, `.s1-badge-recommended`).
- **D3 — the global `s-*` form primitives become canonical (interim).**
  `app.css`'s "Universal Form System" (`.s-input`, `.s-check`, `.s-toggle`,
  …) is built, correct (paper-colored checkmark, token-based), and matches
  the recipes hand-copied across ~11 host/settings files — adopt it and
  delete the copies, rather than deleting it. Long-term these fold into
  ui-kit components (D6). Rename the chat page's colliding decorative
  `.s-field`/`.s-error-msg` classes so names mean one thing.
- **D4 — new tokens** (all values already de-facto standards in the code):

  | Token | Value | Replaces |
  |---|---|---|
  | `--s-radius-sm` | `2px` | ~24 hand-typed instances (ui-kit ×11, settings ×13) |
  | `--s-radius-card` | `10px` | card corners across chat/host |
  | `--s-radius-chip` | `8px` | chip/small-card corners |
  | `--s-radius-pill` | `999px` | pill shapes (`99px` today) |
  | `--s-tap-min` | `44px` | a11y hit-target: `44px` and `2.75rem` (same value) hand-typed ~25× |
  | `--nav-height-conversation`(+`-tablet`,`-mobile`) | `64/112/144px` | copied across 4 files |
  | `--tabbar-height` | *measure first* | `/host` hardcodes `36px`, but TabBar actually renders ≥44px rows — fix the stale math, then tokenize |
  | `--overlay-bg` (redefine) | `light-dark()`-aware scrim | today a dead raw-rgba token; Drawer/ToolStrip hand-roll their own scrims |

  Scrim note: do **not** derive the scrim from `--s-ink` (dark-mode ink is
  light — the scrim would wash white); define it per-mode via `light-dark()`
  or mix from `black`.
- **D5 — one micro-transition duration.** The untokenized `120ms` (×6 files)
  and `150ms` (×15+ declarations) both collapse to `var(--s-t-instant)`
  (.15s) with `var(--s-ease)`; no new token unless design wants two speeds.
- **D6 — ui-kit becomes self-contained (end-state).** `Panel`, `FormField`,
  and `SecretSelect` render classes that exist only in `app.css` (the
  `no-app-coupling` test can't see CSS-class coupling — it only scans import
  specifiers). End-state: the shared utility layer (`.btn*`, `.badge*`,
  `.feedback*`, form primitives) moves into ui-kit so its components render
  correctly for any consumer. Interim: keep the documented bridge, extend it
  to SecretSelect (currently undocumented).
- **D7 — fonts.** The token fonts **do** load — `app.css:1` @imports Poor
  Story + Iosevka Charon Mono, and Google Fonts serves both (verified live
  2026-07-20; an earlier sweep claim that they never load was wrong).
  `app.html:38-43`'s Source Sans 3 + IBM Plex Mono stylesheet is consumed by
  **nothing** (verified) — delete the link, keep the preconnects (they
  benefit the app.css import). Follow-up (white-label/offline story): move
  the @import to a `<link>` and/or self-host.
- **D8 — theme-color metas.** Sync app.html's `#161c22`/`#f9fafb`/`#ffffff`
  constants to the actual `--s-paper` values and pin them with a contract
  test against `tokens.css`; runtime/build-time generation is overkill.

## 4. Refactor tracks

### Track A — fix what breaks theming (do first)

These are the places an operator's `--s-*` override silently fails.
All verified at the cited lines.

| # | Where | Problem → fix |
|---|---|---|
| A1 | `tokens.css:158-164`, `app.css:1677-1680`, `setup/steps/CloudAttachPanel.svelte:124`, `connections/+page.svelte:891-894` | Four on-seal text literals (`#1f1d18`, `#1a0e00` ×2, `white`) → `var(--s-paper)` (D1) |
| A2 | `admin/automations/TaskDrawer.svelte:434-454`, `admin/secrets/SecretsTab.svelte:204-224`, `admin/assistant/AssistantTab.svelte:220-240` | Three hand-rolled checkboxes draw a `white` checkmark on `--s-seal` → adopt `.s-check` (checkmark already `var(--s-paper)`); SecretsTab's is a smaller variant — scale or accept the size change |
| A3 | `setup/steps/Screen1ModelsStep.svelte:365-377` | White check on `--s-moss` → `var(--s-paper)` |
| A4 | `Screen1ModelsStep.svelte:294-297`, `NetworkAccessStep.svelte:248-257`, `ReviewStep.svelte:291-300` | Invented `rgb(242,92,92)` danger red pasted across three files (mixed with seal borders) → one recipe: `color-mix(in srgb, var(--s-error) 12%, transparent)` + `--s-error` text/border (D2) |
| A5 | `Screen1ModelsStep.svelte:496-512` | Amber badge with hex/rgba pairs inside `:global(.dark)` (dead — no `.dark` class exists) + `[data-theme]` branches → `var(--s-warning)` + `color-mix` wash; delete both branches |
| A6 | `Screen1ModelsStep.svelte:514-525`; `Screen2ExtrasStep.svelte:282-284`, `:64` | Invented violet/blue washes + a non-brand `#3b82f6` mic-icon stroke → seal-wash recipe (`color-mix(in srgb, var(--s-seal) 8%, transparent)`) and `var(--s-seal)`/`var(--s-ink-2)` strokes (Discord/Slack brand glyph colors stay) |
| A7 | `Screen2ExtrasStep.svelte:312-358` | Hand-rolled toggle: `#fff` thumb + re-derived track colors at 42×24 while the four `--toggle-*` tokens (36×20) have zero consumers → wire onto the tokens + new `--toggle-thumb`, or delete the tokens; pick one |
| A8 | `chat/+page.svelte:606-615` | `.s-moon` branches on `[data-theme='dark'/'night']` with hand-picked rgba glows → per-mode token (`light-dark()`), component stays mode-agnostic |
| A9 | `chat/ToolLog.svelte:282,291` | `var(--s-radius-sm, 4px)` / `var(--s-bg-hover, rgba(127,127,127,.08))` — neither token exists; always resolves to the literal → real tokens (D4) or direct `color-mix` |
| A10 | `chat/ToolStrip.svelte:196`; `ui-kit Drawer.svelte:119`; `tokens.css:96` | Two hand-rolled scrims (one duplicating `--overlay-bg`'s value, one inlining light-ink rgba) + a dead raw-rgba token → one `light-dark()`-aware `--overlay-bg`, consumed by both (D4 scrim note) |
| A11 | `admin/overview/OperationOutput.svelte:61-62` | Permanently dark terminal (`#e4e8f0`/`#1e2330`) → LogsTab's token recipe (`color-mix(in srgb, var(--s-ink) 3%, var(--s-paper))` + `var(--s-ink-2)`) |
| A12 | `app.css:807,955,1668` | White/grey-alpha hover washes assume a dark surface → `color-mix(in srgb, var(--s-ink) N%, transparent)` |
| A13 | `app.css:1472,1478` | `.deploy-bar-fill` `.ready`/`.stopped` hardcode `#ffb020`/`#d97706` beside token-correct siblings → `var(--s-warning)` / `var(--s-error)` (D2) |
| A14 | `connections/+page.svelte:849-852` | Leftover blue `rgba(37,99,235,.08)` focus glow beside a seal border → `color-mix(in srgb, var(--s-seal) 8%, transparent)` |
| A15 | `connections/+page.svelte:793-808` + `voice/VoiceClientSettings.svelte:575-581`; `connections/+page.svelte:986-993` | `.alert` family and local `.btn-danger` use seal-as-error (and shadow the global `--s-error`-backed `.btn-danger` under the same name) → adopt global `.feedback--error/--warning` and global `.btn-danger` (D2) |
| A16 | `UpdatesTab.svelte:488-497`, `VoiceClientSettings.svelte:511` | Dead `var()` fallbacks (`var(--s-moss, #16a34a)` etc.) — anchors are always defined → drop the fallbacks |
| A17 | `app.html:6,11-12,24-27` | theme-color metas diverge from `--s-paper` → sync + contract-test (D8) |

### Track B — delete dead CSS (~700+ lines, zero visual change)

All confirmed zero-consumer by grep, twice:

- `app.css` orphaned wizard vocabulary (superseded by per-step scoped
  classes): `.provider-grid/-group*` (998-1035), `.auth-row`/`.auth-btn*`
  (1037-1122, keep only the `.step-actions .btn:focus` fragment),
  `.ollama-mode-*` (1124-1174), `.model-group*`/`.model-filter*`
  (1176-1261), `.review-card`/`.review-row*` (1263-1345, keep
  `.deploy-svc-status`), `.options-section*`/`.toggle-grid`/`.channel-cred*`
  (1612-1641), `.nav-info` (in 971-996), dead names in the prose-cap
  selector (`.section-subtitle`, `.panel-description`, `.engine-desc`,
  781-788), `.auth-method-*` dead halves (92-115, incl. undefined
  `var(--transition-fast)`).
- `tokens.css:343-503`: the dead third of `wiz-*` (14 selectors: ledger,
  stamp, local-cta, add-toggle, section-label families).
- `chat/ChatInput.svelte:236`: `animation: s-ripple …` references a keyframe
  that exists nowhere — delete (or reinstate the keyframe deliberately).
- `ui-kit MetricTile.svelte:101`: dead `border` declaration overridden 3
  lines later.
- Decide-and-act (not blind deletes): `setup/ProgressBar.svelte` (orphaned
  component whose ~100 lines of app.css rules are still shipped) and the
  "Universal Form System" (D3 says adopt, not delete).

### Track C — relocate misplaced CSS (app.css → owners)

- `.deploy-*`/`.done-*`/`.service-list*` (~260 lines, 1347-1610) →
  `DeployStep.svelte` (which currently defines only 3 of the ~30 classes it
  renders).
- `.prog-*` (907-969, 1643-1681) → `ProgressBar.svelte` (after the Track B
  decision).
- `.rerun-banner`/`.rerun-back-link` (869-887), `.step-content` (890-900) →
  `routes/setup/+page.svelte`.
- `.setup-page` + `wizard-fade-in` (852-867) → a shared wizard-shell partial
  (two consumers: setup + attention).
- `.step-actions` (971-…) → the same shared partial.

### Track D — consolidate duplicated patterns

New/extended ui-kit components (each replaces 2+ verified hand-rolled copies):

| Component | Replaces |
|---|---|
| `RadioRow` (extend: icon slot, multi-line sub, detail panel, unavailable state) | `Screen1ModelsStep` `.s1-choice-row` (402-474), `NetworkAccessStep` `.network-option-row` (149-197 — an exact recipe match) |
| `SegmentedControl` (pill toggle) | `connections` `.theme-options` (764-791); conversation destinations now use the shared `IconButton` navigation pattern, while Host and Settings share `SectionTabs` |
| `NavTrigger` (icon + eyebrow/value + dot + caret) | `EndpointSwitcher` (41-146), `SessionPicker` (49-155) |
| `ContextCard` | byte-identical copies in `ChatActivity` (132-151) and `ChatNavbar` (196-215) |
| `ActionCard`/`ActionButton` | `PermissionCard` (64-144) and `QuestionCard` (103-218) `s-action-*` families |
| `EmptyState` (exists — adopt + fix collisions) | `ContainersEmptyState` hand-roll; `SessionList` `.state-card`; `EndpointList`/`ChatActivity` `.empty-state`; rename `UpdatesTab`'s third same-named variant |
| Dismiss button (IconButton variant) | `Toast` (106-119) and `UpdateBanner` (96-106) hand-rolled ×'s |
| Tool detail row partial | `ToolLog` (413-434) vs `ToolStrip` (280-303) |
| `.code-chip` utility | `AutomationsTab` (558-564), `AddonsTab` (566-572), `HostImportModal` (126-133) |
| `.sr-only` (define once) | near-identical copies in `AuthGate` (191-201) and `Toast` (127-137) |

Class-adoption consolidations (no new components):

- **Underline input:** adopt global `.s-input/--narrow` at the ~7 sites
  copying the recipe (`BehaviorSection:128-142`,
  `AkmHealthReportSection:154-168`, `EmbeddingSection:124-138`,
  `ImproveProfileDrawer:165-177`, `AgentProfileDrawer:62-73`,
  `AssistantTab:210-211`, `AddonsTab:599-610`) — kills the 8-property
  `!important` fight in `AssistantTab:217`. (`LlmProfileDrawer:99-106` uses
  the same class name for a *different* boxed recipe — rename or align.)
- **Badges:** consolidate on global `.badge*` — local redefinitions in
  `AutomationsTab:496-517`, `ProfileRow:72-89`, `AgentProfilesSection:84-95`;
  parallel inventions `.stream-badge` (`ActivityTab:473-476`),
  `.s-tile-badge` (`MetricTile:93-111`), `.creds-tag`.
- **Chat bubble unification:** the streaming bubble's `:global(.you-words)/
  (.master-words)` in `chat/+page.svelte:660-706` diverges from
  `ChatMessage.svelte:202-238` (1.6rem/300/color-mix border vs
  whisper-token/400/`--s-line`) — one recipe, one place. (Coordinate with
  #426's Presence remount, same file region.)
- **`Brand`-adjacent chrome:** `.msg-copy` vs `.code-copy` in
  `ChatMessage.svelte:322-380` → one copy-button class.
- **`VoiceProfileSelector`:** stop shadowing global `.field-hint`
  (84-92 vs `app.css:300-303`) — one canonical definition + a warning
  modifier if generally useful.

### Track E — tokenize repeated literals

With D4/D5 tokens in place, mechanical sweeps (all sites verified):

- **`var(--nav-height)`** (today: zero consumers): `Navbar:94,99,106`,
  `TabBar:201`, `EndpointSwitcher:47`, `SessionPicker:55`,
  `DeviceSettingsNav:63`, `host/+page.svelte:388` (fix the `36px` half per
  D4 first).
- **`--nav-height-conversation*`**: `Navbar:165,169,181,197`,
  `ChatNavbar:263,270,280,293,298`, `chat/+page.svelte:632,926,984,990`,
  `advanced/+page.svelte:343,488,492`.
- **Type tokens**: `0.75rem`→`--s-type-mark-sm`, `0.875rem`→`--s-type-deed`
  across `SessionList` (×8), `EndpointList` (×6), `ChatNavbar:214,248`,
  `EndpointSwitcher:106,124`, `SessionPicker:116,134`, `ChatActivity:150`,
  `chat/+page.svelte:953-964`, `ConversationNav`, `app.css:938,1666`;
  `TaskDrawer:530`'s `10px` (under the 12px floor) → `--s-type-mark`. Odd
  sizes to reconcile: `ChatNavbar:174` (`0.8125rem`), `Toast:114` (`18px`),
  `UpdateBanner:101` (`1.1rem`), `Drawer:157` (`1.25rem`).
- **Motion**: `150ms`→`--s-t-instant` (`Screen1ModelsStep` ×5,
  `Screen2ExtrasStep`, `ReviewStep` ×3, `TaskDrawer:531`, `tokens.css:154,
  484`); `120ms`→`--s-t-instant` per D5 (`EndpointSwitcher:56`,
  `SessionPicker:64,96`, `ToolStrip:174,261`, `VoiceControl:315,340`,
  `VoiceStatusStrip:124`); `0.12s`→same (`MetricTile:55`,
  `AkmHealthCard:62`, `ConfigureShortcuts:59`); `0.2s`→`--s-t-quick`
  (`app.css:140` — the `.btn` rule, 55 consuming files);
  `cubic-bezier(0.4,0,0.2,1)` literals → `var(--s-ease)`.
- **Radius**: `2px`/`8px`/`10px`/`99px` → the D4 tokens (ui-kit ×11 sites,
  settings ×13, `SessionList` ×10 and siblings).
- **Tap target**: `44px`/`2.75rem` → `--s-tap-min` (~25 sites across host
  akm sections, ProvidersPanel, connections, voice, chrome; exact citations
  in the host/settings sweeps — the settings-surface line numbers need
  re-derivation during implementation, see §7).
- **wiz-* internal hygiene** (`tokens.css`): px spacing on the grid →
  `--s-sp-*`; the parallel 12–16px font scale → `--s-type-*`; survives only
  for selectors still alive after Track B.
- **Spacing**: `Toast:76`, `PasswordInput:51`, `AuthGate:91,107,137,151,180`,
  `UpdateBanner:70-71` (`1px`→`--s-hair`), `app.css:127,186,193` (`.btn`
  paddings — snap to grid or document the touch-target exception),
  `attention/+page.svelte:49` (`3rem` one-offs — accept or extend scale).

### Track F — app.html & fonts

Per D7/D8: delete the Source Sans 3/IBM Plex Mono stylesheet link; keep
preconnects; sync + contract-test the theme-color constants; optional
follow-up to move the token-font @import to a `<link>` or self-host.

### Track G — motion/reduced-motion gaps

- `Screen1ModelsStep:330-351` — `s1shimmer` infinite loop, and the setup
  surface has **no** reduced-motion handling at all → add the standard
  media block.
- `app.css:894` — `.step-content` entrance animation unguarded → guard (or
  it moves with Track C and gains the guard there).
- `ChatInput` dead ripple → Track B.

### Track H — guardrails (make drift impossible, not just fixed)

1. **`styling-hygiene.vitest.ts`** (repo already runs source-scanning
   hygiene suites — `guard-hygiene`, `admin-paths-hygiene`,
   `chrome-untangle-hygiene`; this is the same idiom): scan every component
   `<style>` block and `app.css` for (a) raw hex/`rgb()`/`hsl()` outside an
   explicit allowlist (tokens.css token blocks, SVG filter internals,
   third-party brand glyphs listed by file:line), (b) `[data-theme` in
   component styles, (c) `var(--s-…, fallback)` where the token is one of
   the always-defined anchors, (d) references to undefined `--s-*`/custom
   tokens (catches `--s-radius-2`, `--s-bg-hover`, `--transition-fast`
   -class bugs). New literals then fail CI with the file:line and the rule.
2. **Rewrite `ui-kit/tests/theme-tokens.test.ts` for `light-dark()`** —
   **this is a hard blocker for #426 phase 1**: the suite regexes the
   literal selector lists (`:root[data-theme='light'], :root[data-theme='day']`,
   lines 16-21) and its `parseColor()` (32-55) reads only `#hex`/`rgba()`,
   so the migration makes every test throw. The rewrite parses
   `light-dark(a, b)` pairs and asserts the same WCAG ratios on both
   resolved values.
3. **Template contract check** (from #426): the seeded operator
   `theme.css` template's anchor list must match `tokens.css`.
4. **ui-kit CSS-class coupling**: extend or complement
   `no-app-coupling.test.ts` to flag ui-kit components rendering classes not
   defined within ui-kit (catches the Panel/FormField/SecretSelect bridge
   regressing further) — enforce once D6's migration lands.

## 5. Sequencing

Each phase is independently shippable; every phase ends with the
existing gates green plus screenshot comparison (rubric §10) proving the
default render unchanged (except where a fix corrects an actual bug, e.g.
A12's invisible hover washes on light paper).

1. **Phase 0 — guardrails + tokens** (S): Track H test (baseline allowlist =
   today's violations, ratcheted down as tracks land); D4 token additions;
   theme-tokens.test rewrite prepared.
2. **Phase 1 — Track A** (M): the ~17 breaks-theming clusters. This is what
   makes operator theming *correct*, and it's a prerequisite for
   #426 acceptance ("one anchor override re-tints everything").
3. **Phase 2 — #426 phase 1 lands** (`light-dark()` + `@layer` + test
   rewrite), coordinated with this plan's Phase 0/1.
4. **Phase 3 — Tracks B + C** (M): delete ~700 lines, relocate ~350;
   `app.css` drops from 1704 lines to roughly its true global core.
5. **Phase 4 — Tracks E + F + G** (M): mechanical tokenization sweeps behind
   the hygiene test's ratchet.
6. **Phase 5 — Track D** (L, incremental): component consolidation, one
   pattern at a time; each extraction is its own reviewable change. The
   *design* dimension of this track is owned by **#506** (rev 3: unify the
   entire UI on a single chat-first Stillness language): for each pattern
   it picks the winning design (chat-first, best-of-breed absorbed from
   wizard/host/settings), refines it once in ui-kit, adopts it across all
   surfaces, and deletes the losers — folding each file's Track A fixes
   into the same pass. This plan stays the mechanical-correctness layer;
   don't double-schedule the same surfaces here.
7. **Phase 6 — D6** (L): move the shared utility layer into ui-kit;
   Panel/FormField/SecretSelect become self-contained; enable H4.

## 6. What this buys

- **Theme-ability**: after Phase 1–2, an operator `theme.css` override of
  any anchor reaches every surface — no stranded literals, no
  `[data-theme]` branches, no seal-as-error lies.
- **Consistency**: one badge, one input, one radio row, one empty state, one
  scrim — the same UI concept can no longer silently diverge per page
  (rubric §6 becomes enforceable).
- **Maintainability**: `app.css` shrinks ~60%; every remaining rule has an
  owner; new literals fail CI instead of accreting.

## 7. Verification notes & known citation corrections

- Two findings were refuted on citation accuracy and need line re-derivation
  before use (premises verified sound): the settings-surface `44px`
  inventory (most cited lines pointed at script/markup, not the CSS; the
  token gap itself is real) and ~5 of 23 line cites in the ui-kit wiz-*
  spacing finding (off-by-one/already-tokenized lines; 18 verified).
- Verifier corrections folded in above: TabBar's real height ≥44px (not
  36px); SecretsTab checkbox is a smaller variant; `LlmProfileDrawer`'s
  `.control-input` is a different recipe under the same name; Drawer scrim
  must not mix from `--s-ink`; `ChatNavbar:174` is `0.8125rem` (not
  0.75rem); the two `.sr-only` copies differ by one property; ~25-26 wiz-*
  selectors are live (not ~19), 14 confirmed dead.
- One inter-agent contradiction resolved by live check (2026-07-20): Google
  Fonts serves both token families (incl. `Iosevka Charon Mono` v1), so the
  fonts *do* load via `app.css:1`; only the app.html Source Sans 3/IBM Plex
  Mono load is dead.
- Full per-finding evidence (quoted code, line-verified verdicts, verifier
  notes) lives in the sweep transcripts; this document is the distilled,
  corrected inventory.
