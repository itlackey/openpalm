# Connections Tab Simplification + Host Import

## Context

The Connections tab has accumulated 2,098 LOC across 10 components and become a power-user configuration center rather than a simple wrapper over OpenCode's provider configuration. Users see:
- 5-section editor per provider (Availability, Model, API Key, Connection Settings, Auth Methods)
- Implementation-leakage knobs: base URL override, timeout (ms), custom headers, "set cache key" checkbox, enterprise URL
- A 389-LOC custom-provider form for OpenAI-compatible registration
- A "Detected on this host" probe section with Register buttons
- Env-var displays, source labels (catalog/config/custom), and OAuth prompts inline

What the user actually needs is what OpenCode itself offers in its own web/desktop UI: a list of providers, sign-in (API key or OAuth), and a model picker. Nothing more at the top level.

Additionally, users who already have a working OpenCode install on the host currently have no way to bring those providers across — they must re-enter every API key. We can fix this with a simple file copy: `~/.config/opencode/opencode.json` → `OP_HOME/config/assistant/opencode.json` and `~/.local/share/opencode/auth.json` → `OP_HOME/config/auth.json`.

## Goal

1. Make the Connections tab as simple as OpenCode's own provider UX (or simpler).
2. Add a one-click "Import from host OpenCode" action that copies host config + auth into OP_HOME.
3. Make import the **default path** in the setup wizard whenever host OpenCode is detected.

## Scope

### In scope
- Slim `ProvidersPanel.svelte`, `ProviderEditor.svelte`, `ProviderCard.svelte`, `ProviderFilters.svelte`, `CustomProviderForm.svelte`.
- New backend endpoint `POST /admin/providers/import-host`.
- New backend endpoint `GET /admin/providers/host-status` (detects whether host OpenCode is present, returns counts).
- Setup wizard provider step: detect host config; if present, default the choice to "Import".

### Out of scope
- Changing the OpenCode integration boundary (OAuth subprocess, `/provider`, `/provider/auth`, `/auth/{id}` proxying — all unchanged).
- Removing power-user capability entirely — advanced settings stay reachable behind a single disclosure.
- macOS/Windows host paths — Linux only for now (XDG `~/.config` + `~/.local/share`). Document the OS-specific paths to add later.

## UX Redesign — match OpenCode's own Providers UI

**Reference:** OpenCode's desktop/web UI (verified at `http://localhost:4096/` Settings → Providers + Models) is the simplicity target. Its surface is:

- **Providers** tab = a flat list. Each row = `icon + name + auth-type pill (Environment / API key / Config / Custom) + [Disconnect] button`. Below the connected list, a "Popular providers" section with `[Connect]` buttons for unconnected entries. One special row at the bottom: "Custom provider" → `[Connect]` opens an OpenAI-compatible form. A `[Show more providers]` button reveals the long tail.
- **Models** tab = search box + per-provider model groups, each model with an on/off toggle.

There is **no** per-row model dropdown, no Base URL field, no timeout, no headers, no env-var display, no "configured" badge, no filter chips, no two-column layout, no detail panel. OpenCode trusts `opencode.json` to be edited directly for anything advanced. We will do the same.

### OpenPalm Connections tab layout

```
┌──────────────────────────────────────────────────────────────┐
│  Connections                            [Import from host…]  │
│                                                              │
│  Connected providers                                         │
│  ─────────────────────────────────────────────────────────── │
│   ◎ Anthropic            [ API key ]          [ Disconnect ] │
│   ◎ OpenAI               [ API key ]          [ Disconnect ] │
│   ◎ Ollama (local)       [ Custom ]           [ Disconnect ] │
│                                                              │
│  Popular providers                                           │
│  ─────────────────────────────────────────────────────────── │
│   Anthropic              Claude models           [ Connect ] │
│   Google Gemini          Gemini models           [ Connect ] │
│   Groq                   Fast inference          [ Connect ] │
│   OpenRouter             Many providers, one key [ Connect ] │
│   Custom provider        OpenAI-compatible       [ Connect ] │
│                                          [ Show more ▾ ]     │
└──────────────────────────────────────────────────────────────┘
```

- One column, one section per state (Connected / Popular). Custom is one row in Popular.
- No search box on the connections page (the OpenCode reference omits it; the connected list is short and the popular list has Show-more for the long tail).
- Auth-type pill values: `Environment` (env var set), `API key` (saved in auth.json), `OAuth` (OAuth in auth.json), `Config` (configured in opencode.json without credential), `Custom` (custom-registered).
- "Import from host…" button top-right — disabled unless `GET /admin/providers/host-status` reports presence.

### Click `[Connect]` on a popular provider

A small inline form appears in-place (no modal, no separate page):

- If OAuth supported: `[ Sign in with <Provider> ]` button — opens OAuth window via existing `providers/oauth/start` subprocess. Status spinner while polling for callback.
- If API key supported: single password field + `[ Save ]`. Sent to OpenCode's `/auth/{id}` (unchanged from today).
- If both: API key by default, "Sign in with OAuth instead" link.

That's the entire interaction. No "Default model", no "Connection settings", no env var display, no model count. After Connect succeeds, the row moves to "Connected providers" with the appropriate pill.

### Click `[Connect]` on "Custom provider"

Inline form, 4 fields:
- ID (slug)
- Display name
- Base URL
- API key (optional)

Models auto-discovered on first connection. No headers field, no models grid, no overwrite checkbox. (Power users editing `opencode.json` directly can set headers; we do not surface this in UI.)

### Click `[Disconnect]`

Confirmation dialog: "Disconnect <Name>? Stored credentials will be removed." → calls `DELETE /admin/opencode/providers/:id/auth` (already exists) → row moves to Popular providers.

### Model enablement

**Out of scope for the Connections tab.** OpenCode has a separate Models tab for per-model toggles; OpenPalm's existing Capabilities tab covers the "which model fills which role" question (LLM, embeddings, TTS, etc.). The Connections tab does not need a model picker at all. Per-provider model selection (`activeMainModel`/`activeSmallModel` on `ProviderView`) is removed from the Connections UI.

### Power-user knobs

Not exposed in the UI. Users who need `timeout`, custom `headers`, `setCacheKey`, or `enterpriseUrl` edit `OP_HOME/config/assistant/opencode.json` directly — same as OpenCode itself expects. The backend `PATCH /admin/providers/[id]` kinds for these stay in place (no data path removal); only the UI surface narrows.

### Import from host (modal)

```
┌──────────────────────────────────────────────────────┐
│  Import from host OpenCode                           │
│                                                      │
│  We found an OpenCode installation on this host:     │
│    ~/.config/opencode/opencode.json   (5 providers)  │
│    ~/.local/share/opencode/auth.json  (3 credentials)│
│                                                      │
│  Importing will:                                     │
│    • Copy provider settings into OP_HOME             │
│    • Copy stored credentials (API keys, OAuth tokens)│
│    • Merge with anything you've already configured   │
│                                                      │
│  Existing OP_HOME credentials are preserved on       │
│  conflict — you can review and overwrite per         │
│  provider after import.                              │
│                                                      │
│      [ Cancel ]              [ Import providers ]    │
└──────────────────────────────────────────────────────┘
```

### Setup wizard integration

The wizard already has a Providers step (currently shows OpenCode catalog or hardcoded fallback). Change:

1. On wizard load, call `GET /admin/providers/host-status` once.
2. If host config detected, the providers step becomes:
   ```
   We found OpenCode on this host with N providers configured.

   ●  Import from host OpenCode (recommended)
   ○  Configure providers manually
   ```
   Default = Import. Clicking Continue runs the import and skips the manual provider entry.
3. If host config is absent, the existing manual flow stays as-is.

## Implementation

### Phase A — Backend: import + status endpoints (lib + UI)

**New in `packages/lib/src/control-plane/`:**
- `host-opencode.ts`
  - `detectHostOpenCode(): { configPath?: string; authPath?: string; providerCount: number; credentialCount: number }` — scans `$XDG_CONFIG_HOME` (or `~/.config`) and `$XDG_DATA_HOME` (or `~/.local/share`).
  - `importHostOpenCode(state, options): { imported: { providers: number; credentials: number }; conflicts: string[] }` — copies, merges, chmods. Strips `plugin`, `mcp`, `permission` from imported `opencode.json` (per memory: "Project config accepts ONLY: $schema, plugin" — verify before merging; keep only `provider`, `model`, `small_model`, `disabled_providers`).

**New routes in `packages/ui/src/routes/admin/providers/`:**
- `host-status/+server.ts` — GET; thin wrapper around `detectHostOpenCode`. Never returns credential values.
- `import-host/+server.ts` — POST; calls `importHostOpenCode`. Audit-logged. Optional body `{ overwriteConflicts: boolean }` (default false).

**Security:**
- Both endpoints require `requireAdmin`.
- `auth.json` is copied byte-for-byte (no parse-and-rewrite) and chmodded to `0o600`. Never logged.
- Conflict detection compares provider IDs; existing credentials are preserved unless `overwriteConflicts=true`.

### Phase B — Frontend: slim the components

| File | Current LOC | Target LOC | Strategy |
|---|---|---|---|
| `ProvidersPanel.svelte` | 435 | ~100 | Two-section list (Connected / Popular). Drop local-probe block, filter chips, search box, two-column layout. Top-right Import button. |
| `ProviderEditor.svelte` | 748 | **delete** | No separate editor. Connect/Disconnect happen inline on the row. |
| `ProviderCard.svelte` | 138 | ~40 | One row: icon + name + auth pill + Connect/Disconnect button. No badge row, no model summary. |
| `ProviderFilters.svelte` | 106 | **delete** | No search/filter; the list is short and split by Connected/Popular. |
| `CustomProviderForm.svelte` | 389 | ~60 | 4 fields, inline form that appears on `[Connect]` click on the Custom row. No models grid, no headers, no overwrite checkbox. |
| **New** `ConnectInline.svelte` | — | ~80 | Small inline form shown when `[Connect]` is clicked on a Popular row. API key field OR OAuth button, depending on auth methods. |
| **New** `HostImportModal.svelte` | — | ~120 | Modal with detected counts, conflict preview, Import button. |

Total: 1,816 → ~200 LOC plus ~200 LOC new = **net ~−1,416 LOC**.

CapabilitiesTab is unchanged (separate concern: role assignment, not provider sign-in).

### Phase C — Setup wizard integration

In `packages/ui/src/routes/setup/+page.svelte` (and its server hooks under `src/routes/api/setup/`):
- On wizard mount, call `host-status` once.
- Providers step renders two radio options when host detected: Import (default, recommended) vs Configure manually.
- "Import" selection calls `POST /admin/providers/import-host`, then auto-advances to the model-selection step pre-populated from imported providers.
- Skip the OAuth/provider-detection polling loop entirely when import is chosen.

### Phase D — Removed code

Confirm via grep and delete:
- Local probe UI ("Detected on this host" block in `ProvidersPanel.svelte`).
- `setCacheKey` field handling (UI + server param parsing in `PATCH /admin/providers/[id]` kind=options).
- Enterprise URL conditional rendering — collapse into a single Base URL field; document that Copilot users should use the GHE URL there.
- `env[]` display blocks in `ProviderCard.svelte` and `ProviderEditor.svelte`.
- Filter chip implementation + counts in `ProviderFilters.svelte`.

The backend `PATCH /admin/providers/[id]` keeps all kinds — the UI just stops sending some. (Power users editing `opencode.json` directly retain access.)

## Verification

1. **Type/lint:** `bun run check` — 0 errors.
2. **UI tests:** `bun run ui:test:unit` — all 406+ pass; add new vitests for `host-status` and `import-host` endpoints (mock filesystem).
3. **Mocked Playwright:** `bun run ui:test:e2e:mocked` — pass; add new test for the import modal happy path.
4. **Manual stack test (host with OpenCode installed):**
   - Verify `GET /admin/providers/host-status` returns the right counts.
   - Click "Import from host", confirm `OP_HOME/config/assistant/opencode.json` and `OP_HOME/config/auth.json` are populated.
   - Verify `auth.json` is mode `0600` after import.
   - Verify providers list refreshes and shows imported providers as Connected.
   - Reset OP_HOME, run setup wizard, verify Import is pre-selected and works end-to-end.
5. **Manual stack test (host without OpenCode):**
   - Verify `host-status` returns `{ providerCount: 0, credentialCount: 0 }` and the Import button is disabled.
   - Verify setup wizard falls back to the existing manual provider flow.
6. **Power-user path still works:** Verify that a user who edits `OP_HOME/config/assistant/opencode.json` directly to add `timeout`, `headers`, or `setCacheKey` sees those values respected by OpenCode (we just stopped showing them in the UI; the data path is unchanged).

## Non-goals

- No changes to the OpenCode integration. We do not replace OAuth, do not maintain our own catalog, do not bypass `/provider`/`/auth`.
- No automatic background sync from host. Import is an explicit user action; subsequent host changes won't auto-propagate.
- No macOS/Windows host paths in this pass — Linux only; add later behind the same API contract.
- No deletion of backend `PATCH /admin/providers/[id]` action kinds. The data path remains; only the UI surface narrows.

## Expected outcome

- Connections tab LOC reduced ~80% (1,816 → ~200 + 200 new = ~400 total).
- Visual + interaction parity with OpenCode's own Providers UI (Connected list + Popular list, auth pill, Connect/Disconnect).
- Default user journey: install OpenPalm on a machine with existing OpenCode → wizard offers Import → one click → providers ready.
- Model-role assignment continues to live in the Capabilities tab (OpenPalm-specific concern; no OpenCode equivalent).
- No advanced settings in the UI — power users edit `opencode.json` directly, exactly like with OpenCode itself.
