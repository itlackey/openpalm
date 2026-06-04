# OpenPalm UI Dark Mode Plan

**Date:** 2026-06-04
**Scope:** Add a first-party dark mode to the OpenPalm SvelteKit UI in `packages/ui/` without expanding scope into a broad visual redesign.

## TL;DR

OpenPalm already has the right foundation for dark mode: a global token file in `packages/ui/src/app.css` and broad usage of `var(--color-...)` across the UI. The most effective implementation is to add a persisted theme preference, define dark token values centrally, add a compact navbar toggle, and then normalize the remaining hardcoded light-oriented colors onto shared tokens.

The embedded OpenCode "Advanced" page is a separate theming surface inside an iframe. For this release, OpenPalm dark mode and OpenCode theme selection may need to be configured independently.

## Current State

### Existing strengths

- `packages/ui/src/app.css` already defines shared design tokens for color, spacing, typography, radius, shadow, and common utilities.
- `packages/ui/src/app.html` is available for pre-hydration theme bootstrap and browser-chrome metadata.
- `packages/ui/src/routes/+layout.svelte` is thin and imports the global stylesheet, which makes it the right place to initialize client-side theme state.
- `packages/ui/src/lib/components/Navbar.svelte` is the natural place for a user-visible theme toggle.
- Most primary UI surfaces already consume CSS custom properties instead of component-local hardcoded palettes.

### Current gaps

- The global token file only defines the light palette today.
- There is no shared client-side theme state or persisted theme preference.
- `packages/ui/src/app.html` currently hardcodes light-oriented browser hints (`theme-color` and `color-scheme`), so a layout-only client init would still allow a light first paint.
- Several routes and components still contain hardcoded light-biased colors or fallback values that will not look correct in dark mode.
- Token naming is inconsistent in places: the UI currently mixes concepts such as `primary` vs `accent`, `danger` vs `error`, and `text-secondary` vs `text-muted`.
- The embedded OpenCode web UI shown in `routes/advanced/+page.svelte` is rendered inside an iframe and does not inherit OpenPalm CSS tokens.

## Constraints

- Keep the implementation simple and local to the UI package.
- Prefer centralized token changes over one-off component overrides.
- Avoid introducing a complex theming framework or dependency.
- Preserve current OpenPalm brand language, especially the amber primary accent.
- Do not treat OpenCode theme synchronization as required scope for this release.

## Implementation Plan

### 1. Add a minimal theme state module

Create a small client-side helper in `packages/ui/src/lib/` that:

- supports `light`, `dark`, and `system`
- persists the user choice in `localStorage`
- resolves `system` through `matchMedia('(prefers-color-scheme: dark)')`
- applies the resolved theme to `document.documentElement` via a stable attribute such as `data-theme`

This should stay small and explicit. A lightweight state module is enough; no external store library is needed.

### 2. Bootstrap the theme before hydration

Update `packages/ui/src/app.html` so dark mode can be applied before the app hydrates.

Goals:

- avoid a white flash when a persisted dark preference exists
- keep browser chrome in sync through `meta[name="theme-color"]`
- set `color-scheme` correctly for native controls and scrollbars

This should stay intentionally small: read the persisted value, resolve `system` if supported, set the root theme attribute, and update the relevant metadata.

### 3. Initialize shared theme state from the root layout

Update `packages/ui/src/routes/+layout.svelte` to initialize the theme on the client.

Goals:

- apply the theme once near the top of the app tree
- avoid duplicating initialization logic across routes
- keep server/client boundaries clean

This step should own the long-lived reactive wiring after the early bootstrap in `app.html`.

### 4. Add dark token values to `app.css`

Extend `packages/ui/src/app.css` so the current `:root` values remain the light theme and add a dark-theme override block keyed off the root theme attribute.

The dark token set should cover at least:

- page and panel backgrounds
- elevated surfaces and hover surfaces
- borders and focus treatment
- primary, success, danger, warning, and info semantic colors
- muted text and tertiary text
- overlays, shadows, and selected states
- shared utility surfaces used by buttons, badges, banners, sheets, and panels

The dark palette should stay aligned with the current visual identity rather than switching to a generic blue-gray theme.

### 5. Consolidate token vocabulary where it has drifted

Before or during the component audit, normalize the token vocabulary used by the UI.

At minimum, make a deliberate decision for these mismatches and update usage accordingly:

- `primary` vs `accent`
- `danger` vs `error`
- `text-secondary` vs `text-muted`

The goal is not to add a second abstraction layer. The goal is to reduce regressions by making components consume one canonical token vocabulary.

### 6. Add a theme toggle to the navbar

Update `packages/ui/src/lib/components/Navbar.svelte` to expose the theme control.

Requirements:

- compact enough for the existing toolbar layout
- usable on desktop and narrow widths
- consistent with the existing button styling language
- accessible labeling and focus states

Recommended behavior:

- allow explicit `light` and `dark`
- include `system` if it can be presented without making the control awkward

If a 3-state control makes the navbar too busy, a simple light/dark toggle is acceptable for this release, with `system` deferred.

Important limitation:

- setup and auth-oriented screens that do not render `Navbar.svelte` may not expose an on-screen theme control in the first release

That is acceptable if the persisted theme still applies correctly across those routes.

### 7. Normalize hardcoded colors onto tokens

Audit the UI for components and routes that still use hardcoded colors or brittle light-theme fallbacks. Replace those values with shared tokens before relying on dark mode globally.

Priority targets:

- `packages/ui/src/app.html`
- `packages/ui/src/lib/components/Navbar.svelte`
- `packages/ui/src/lib/components/EndpointSwitcher.svelte`
- `packages/ui/src/lib/components/SessionPicker.svelte`
- `packages/ui/src/lib/components/AuthGate.svelte`
- `packages/ui/src/lib/components/FriendlyError.svelte`
- `packages/ui/src/routes/admin/endpoints/+page.svelte`
- setup flow components under `packages/ui/src/routes/setup/steps/`
- feature-heavy tabs such as AKM, Voice, Logs, Overview, and Secrets

The goal is not to eliminate every fallback in the codebase immediately, but to remove the ones that would create obvious dark mode regressions in primary user flows.

High-risk audit areas called out by current code review:

- navbar-adjacent controls under `lib/components/`
- `routes/admin/endpoints/+page.svelte`
- setup flow steps such as `SystemCheckStep`, `ProvidersStep`, `ReviewStep`, and `DeployStep`
- rich tabs such as `OverviewTab`, `AkmTab`, and `VoiceTab`

### 8. Verify the embedded OpenCode seam separately

The OpenPalm page chrome around `/advanced` should follow the OpenPalm theme tokens. The iframe contents are a separate OpenCode application.

For this release:

- ensure the OpenPalm host page around the iframe looks correct in dark mode
- do not block dark mode delivery on automatic OpenCode iframe theme synchronization
- document that OpenPalm UI theme and OpenCode theme may need to be set independently

This is an acceptable limitation because the iframe is an external UI boundary from the perspective of the SvelteKit app.

### 9. Validate primary routes in both themes

Manual verification should cover:

- `/chat`
- `/advanced`
- `/admin`
- `/admin/endpoints`
- setup wizard routes
- major sheets, banners, panels, forms, and badges

Validation should specifically check:

- readable foreground/background contrast
- no light flash on cold load when a persisted dark preference exists
- hover and focus visibility
- selected and active states
- sticky navbar translucency
- error, warning, and success treatments
- code/monospace surfaces and subtle borders
- browser chrome metadata such as `theme-color` and `color-scheme`
- no horizontal overflow or clipped toolbar controls around 600px, 480px, and 360px widths
- mobile and narrow-width navbar behavior after adding the toggle

### 10. Run the standard UI verification

At minimum:

- `cd packages/ui && npm run check`

Recommended focused automation for this feature:

- one browser-oriented test that verifies the persisted preference survives reload
- one check that the root theme attribute is applied on load
- one accessibility check that the theme toggle is keyboard-operable

Avoid broad visual snapshot testing for the first release.

## Release Limitation: OpenCode Theme Sync

OpenPalm includes an embedded OpenCode web UI under the Advanced page, but that UI is rendered inside an iframe and uses OpenCode's own theming/config system.

For this release, we should explicitly accept the following limitation:

- OpenPalm dark mode does not need to automatically synchronize the embedded OpenCode theme.
- Users may need to set the OpenPalm UI theme and the OpenCode theme independently.

This limitation should be documented in release notes or operator-facing notes if the feature ships in this state.

## Risks And Complexity Notes

### Main implementation risk

The largest risk is not the root token swap. It is the number of scattered hardcoded colors and per-component fallbacks that will remain visually incorrect in dark mode unless they are normalized.

### Complexity to avoid

- Do not add a full theme abstraction layer.
- Do not introduce server-stored user theme preferences for the first release.
- Do not block the work on trying to deeply coordinate OpenPalm CSS tokens with the embedded OpenCode iframe.

## Recommended Delivery Order

1. Add root theme state and persistence.
2. Add the early bootstrap in `app.html`.
3. Add dark token values in `app.css`.
4. Normalize token vocabulary drift where it affects shared controls.
5. Add the navbar toggle.
6. Fix high-visibility hardcoded color hotspots.
7. Verify primary routes, first paint, and responsive behavior.
8. Run `npm run check` and focused theme tests.
9. Document the OpenCode iframe theme limitation.

## Acceptance Criteria

- The OpenPalm UI supports a user-selectable dark mode.
- The selected theme persists across reloads.
- No light first-paint flash occurs for a persisted dark preference.
- A defined set of primary routes is visually usable in both light and dark themes: `/chat`, `/admin`, `/admin/endpoints`, `/advanced` host chrome, and core setup wizard routes.
- Shared surfaces use centralized tokens instead of one-off dark patches.
- Navbar actions still fit at narrow widths without clipped or overlapping controls.
- The `/advanced` host page respects OpenPalm dark mode.
- The release notes or technical notes acknowledge that embedded OpenCode theme synchronization is not automatic for this release.
