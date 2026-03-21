# Implementation Plan: Provider/Model Configuration UI (Issue #350)

## Overview

Add a browser-based UI for configuring providers and models via the OpenCode server API, integrated into the existing SvelteKit setup wizard. OpenCode remains the sole source of truth for provider/model configuration. The UI uses right-side sheet modals that match the wizard's design system.

## Architecture Decisions

### 1. Server-Side Proxy (Unanimous)

All OpenCode API calls go through SvelteKit server routes. No direct browser-to-OpenCode communication.

```
Browser → POST /admin/opencode/providers (SvelteKit) → GET/POST http://assistant:4096/... (internal)
```

**Rationale:**
- OpenCode has no CORS headers and runs on an internal port
- Maintains the LAN-first security boundary
- Consistent with existing `client.server.ts` proxy pattern
- Admin token validation via `requireAdmin()` on every route

### 2. Sheet Modal UI (Not Inline Panels)

Three-level flows use right-side sheet modals (drawers) instead of stacking inline panels.

**Rationale:**
- 3 levels of inline `.panel` nesting creates excessive vertical travel
- Sheet provides clear visual separation for multi-step flows
- Converts to bottom sheet on mobile (<520px)
- Uses existing `.panel` vocabulary internally (header/body/footer)

### 3. Environment Variables Remain the Configuration Path

Provider credentials and model selection are stored in `vault/user/user.env` as environment variables. The broken `writeOpenCodeProviderConfig()` function (which crashes OpenCode v1.2.24) is removed. OpenCode's own auth API is used as a non-critical runtime supplement.

### 4. Graceful Degradation

All OpenCode API calls return safe defaults when OpenCode is unreachable. The UI displays "Assistant not running" state rather than errors.

## Confirmed OpenCode API Surface (probed live on 2026-03-21)

All endpoints below are **verified against running OpenCode v1.2.24** via `/doc` (OpenAPI 3.1.1).

### Provider & Auth Endpoints

| Endpoint | Method | Purpose | Request | Response |
|----------|--------|---------|---------|----------|
| `GET /provider` | GET | List all providers with models | — | `{ all: Provider[] }` |
| `GET /provider/auth` | GET | Get auth methods per provider | — | `Record<string, ProviderAuthMethod[]>` |
| `PUT /auth/{providerID}` | PUT | Set credentials (API key or OAuth) | `ApiAuth \| OAuth \| WellKnownAuth` | `boolean` |
| `DELETE /auth/{providerID}` | DELETE | Remove credentials | — | `boolean` |
| `POST /provider/{providerID}/oauth/authorize` | POST | Start OAuth flow | `{ method: number }` | `{ url, method: 'auto'\|'code', instructions }` |
| `POST /provider/{providerID}/oauth/callback` | POST | Complete OAuth | `{ method: number, code?: string }` | `boolean` |

### Config Endpoints

| Endpoint | Method | Purpose | Response |
|----------|--------|---------|----------|
| `GET /config` | GET | Get project config | Config object (model, plugins, etc.) |
| `PATCH /config` | PATCH | Update project config | Updated Config |
| `GET /config/providers` | GET | List configured providers with models | `{ providers: Provider[], default: Record<string, string> }` |
| `GET /global/config` | GET | Get global config | Config object |
| `PATCH /global/config` | PATCH | Update global config | Updated Config |
| `GET /global/event` | GET | SSE event stream | `text/event-stream` |

### Auth Schemas (from OpenAPI)

```typescript
type ApiAuth = { type: 'api'; key: string };
type OAuth = { type: 'oauth'; refresh: string; access: string; expires: number; accountId?: string; enterpriseUrl?: string };
type WellKnownAuth = { type: 'wellknown'; key: string; token: string };
type ProviderAuthMethod = { type: 'oauth' | 'api'; label: string };
```

### Provider Schema

```typescript
type Provider = {
  id: string;
  name: string;
  source: 'env' | 'config' | 'custom' | 'api';
  env: string[];          // Required env vars (e.g., ["OPENAI_API_KEY"])
  options: Record<string, unknown>;
  models: Record<string, Model>;
};
```

### Key Findings from Live API

1. **`/provider/auth`** returns auth methods keyed by provider ID (e.g., `{ openai: [{ type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' }, { type: 'api', label: 'Manually enter API Key' }] }`)
2. **OAuth flow** is index-based: `POST /provider/{id}/oauth/authorize` takes `{ method: number }` (index into the auth methods array) and returns `{ url, method, instructions }`
3. **API key auth** uses `PUT /auth/{providerID}` with `{ type: 'api', key: 'sk-...' }`
4. **`/config/providers`** returns providers with full model catalogs and default assignments
5. **`GET /global/event`** provides SSE for real-time state changes (auth completion, config updates)
6. **No `/auth` root endpoint** (404) — credentials are managed per-provider via `/auth/{providerID}`

### Step 1: Fix Known Bugs

1. **Fix `/providers` → `/provider` endpoint** in `client.server.ts:24` (confirmed wrong)
2. **Remove `writeOpenCodeProviderConfig()` calls** from:
   - `packages/admin/src/routes/admin/connections/assignments/+server.ts` (lines 80-96)
   - `packages/admin/src/routes/admin/connections/+server.ts` (lines 411-420)
3. **Deprecate `writeOpenCodeProviderConfig()`** in `packages/lib/src/control-plane/connection-mapping.ts`

## New Files

### Server-Side (SvelteKit Routes)

| File | Purpose |
|------|---------|
| `src/routes/admin/opencode/providers/+server.ts` | GET: list providers from OpenCode |
| `src/routes/admin/opencode/providers/[id]/models/+server.ts` | GET: list models for a provider |
| `src/routes/admin/opencode/providers/[id]/auth/+server.ts` | POST: initiate auth; GET: SSE poll stream |
| `src/routes/admin/opencode/model/+server.ts` | GET: current model; POST: set model (writes env) |

### Client-Side API

| File | Purpose |
|------|---------|
| `src/lib/opencode/providers-api.ts` | Typed fetch wrappers for admin proxy routes |

### UI Components

| File | Purpose |
|------|---------|
| `src/lib/components/opencode/ModalSheet.svelte` | Reusable sheet container with overlay, focus trap, Escape |
| `src/lib/components/opencode/ManageModelsSheet.svelte` | Model list with toggles, default selector |
| `src/lib/components/opencode/ConnectProviderSheet.svelte` | Searchable provider picker grid |
| `src/lib/components/opencode/ConnectDetailSheet.svelte` | Auth method selection + credential form |
| `src/lib/components/opencode/ProviderAuthDevice.svelte` | Device auth polling sub-panel |

All paths relative to `packages/admin/`.

## Modified Files

| File | Change |
|------|--------|
| `src/lib/opencode/client.server.ts` | Fix `/providers` → `/provider`; add `proxyToOpenCode` helper; add provider/model/auth functions |
| `src/lib/components/ConnectionsTab.svelte` | Add `showProvidersPanel`/`showModelsPanel` state; add "Manage Models" and "Connect Provider" buttons |
| `src/lib/types.ts` | Add `OpenCodeProviderSummary`, `OpenCodeModelInfo`, `DeviceAuthResponse` types |
| `src/app.css` | Add sheet, toggle, provider card, filter pill CSS tokens |
| `src/lib/api.ts` | Add `fetchOpenCodeProviders`, `getOpenCodeModels`, `initiateProviderAuth`, `pollProviderAuth` |
| `packages/lib/src/control-plane/connection-mapping.ts` | Deprecate `writeOpenCodeProviderConfig` |
| `src/routes/admin/connections/assignments/+server.ts` | Remove `writeOpenCodeProviderConfig` call |
| `src/routes/admin/connections/+server.ts` | Remove `writeOpenCodeProviderConfig` call |

## Component Architecture

### Sheet Modal System

```
ConnectionsTab.svelte
  ├── [Manage Models] button → ManageModelsSheet
  │     └── ModalSheet (wide: 640px)
  │           └── Model list grouped by provider
  │                 ├── Search filter
  │                 ├── Provider groups (collapsible <details>)
  │                 │     └── Model rows with toggle + default selector
  │                 └── Save/Cancel footer
  │
  └── [Connect Provider] button → ConnectProviderSheet
        └── ModalSheet (standard: 480px → wide: 640px)
              ├── Search + category filter pills
              ├── Provider card grid
              └── On card click → ConnectDetailSheet
                    └── ModalSheet (480px, stacked over provider sheet)
                          ├── Auth method radio cards
                          ├── Conditional form (API key / device auth / none)
                          │     └── ProviderAuthDevice (polling sub-panel)
                          └── Test & Save footer
```

### State Management (Svelte 5 Runes)

```typescript
// In ConnectionsTab.svelte — flat $state variables
let showModelsSheet = $state(false);
let showConnectSheet = $state(false);

// In ConnectProviderSheet — discriminated union view
type ConnectView =
  | { kind: 'picker'; filterQuery: string; category: string }
  | { kind: 'detail'; provider: ProviderDefinition; filterQuery: string; category: string };
let view = $state<ConnectView>({ kind: 'picker', filterQuery: '', category: 'all' });

// Back navigation preserves filter state:
// view = { kind: 'picker', filterQuery: view.filterQuery, category: view.category }
```

### ModalSheet Component

```typescript
interface Props {
  open: boolean;
  wide?: boolean;         // 640px vs 480px
  title: string;
  backLabel?: string;     // Shows back button if set
  onClose: () => void;
  onBack?: () => void;
}
```

Features:
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
- Focus trap (Tab cycles within sheet)
- Escape key closes entire stack
- Overlay click closes
- `document.body.style.overflow = 'hidden'` while open
- Slide-in animation from right; bottom sheet on mobile

## Server-Side API Design

### `proxyToOpenCode()` Helper

```typescript
// In client.server.ts
async function proxyToOpenCode(
  path: string,
  options?: RequestInit
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; code: string; message: string }> {
  try {
    const res = await fetch(`${OPENCODE_BASE_URL}${path}`, {
      ...options,
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, status: res.status >= 500 ? 502 : res.status,
               code: 'opencode_error', message: body.message ?? `OpenCode returned ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, status: 503, code: 'opencode_unavailable', message: 'OpenCode is not reachable' };
  }
}
```

### Endpoint Specifications

#### GET /admin/opencode/providers
- Auth: `requireAdmin(event, requestId)`
- Proxies: `GET ${OPENCODE_URL}/provider`
- Response: `{ providers: [{ id, name, connected, models? }] }`
- Fallback: `{ providers: [] }` on 503

#### GET /admin/opencode/providers/[id]/models
- Auth: `requireAdmin`
- Proxies: `GET ${OPENCODE_URL}/provider` (filter by id, extract models)
- Response: `{ models: [{ id, name, enabled }] }`
- Fallback: `{ models: [] }` on 503/404

#### POST /admin/opencode/providers/[id]/auth
- Auth: `requireAdmin`
- Body: `{ mode: 'api_key', apiKey: string }` or `{ mode: 'device_code' }`
- API key mode: Writes to `vault/user/user.env`, optionally calls OpenCode auth API
- Device code mode: Initiates flow, returns `{ pollToken, userCode, verificationUri }`
- Response narrowed — never returns raw tokens

#### GET /admin/opencode/providers/[id]/auth/poll
- Auth: `requireAdmin`
- Query: `?pollToken=<token>`
- Response: SSE stream (`text/event-stream`)
- Server polls OpenCode internally at 5s intervals
- Events: `{ status: 'pending' | 'complete' | 'error', message }`
- Auto-closes on completion, error, or 900s timeout

#### GET /admin/opencode/model
- Proxies: `GET ${OPENCODE_URL}/config` or equivalent
- Returns: `{ model, provider }`

#### POST /admin/opencode/model
- Body: `{ provider, model, connectionId }`
- Writes `SYSTEM_LLM_PROVIDER` + `SYSTEM_LLM_MODEL` to `vault/user/user.env`
- Optionally calls OpenCode live model-switch API (non-critical)
- Response: `{ ok, liveApplied, restartRequired, message }`

## CSS Design

### New Tokens (added to `:root` in app.css)

```css
--sheet-width: 480px;
--sheet-width-wide: 640px;
--overlay-bg: rgba(0, 0, 0, 0.35);
--shadow-sheet: -4px 0 24px rgba(0, 0, 0, 0.12), -1px 0 4px rgba(0, 0, 0, 0.06);
--toggle-width: 36px;
--toggle-height: 20px;
--toggle-bg-off: var(--color-border-hover);
--toggle-bg-on: var(--color-primary);
--provider-card-size: 96px;
--color-border-selected: var(--color-primary);
--color-bg-selected: var(--color-primary-subtle);
```

### New Component Classes

- `.sheet-overlay` / `.sheet` / `.sheet--wide` / `.sheet-header` / `.sheet-body` / `.sheet-footer`
- `.model-toggle` / `.model-toggle-track` (CSS-only toggle switch)
- `.provider-grid` / `.provider-card` / `.provider-card--selected`
- `.auth-method-group` / `.auth-method-card` / `.auth-method-card--selected`
- `.filter-pills` / `.pill` / `.pill--active`

### Responsive

At `<520px`: sheet becomes bottom sheet (full width, max-height 90dvh, slides up from bottom).

## Security Requirements

### Must-Fix Before Merging

- [ ] No endpoint returns resolved API key values — only env var names (`apiKeySecretRef`)
- [ ] All new `client.server.ts` functions have `AbortSignal.timeout()`
- [ ] No direct browser-to-OpenCode communication
- [ ] Raw browser request body never forwarded verbatim to OpenCode — fields individually validated
- [ ] `requireAdmin(event, requestId)` on every new route
- [ ] Body size limit via `parseJsonBody`

### Device Auth Security

- [ ] `device_code` held server-side only; browser receives opaque `pollToken`
- [ ] Polling URL from OAuth provider validated with `validateExternalUrl`
- [ ] Flow entries expire after 10-minute TTL
- [ ] Access tokens written to `vault/user/user.env` server-side, never returned to browser

### SSRF Fix

- [ ] Add `localhost` to blocked hostnames in `validateExternalUrl` (currently only blocks `127.x` IPs)
- [ ] Add regression test for `http://localhost:4096/v1`

## Accessibility Requirements

- Sheet: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
- Focus moves to first interactive element on open; returns to trigger on close
- Focus trap: Tab cycles within sheet only
- Escape closes entire sheet stack
- Provider grid: `role="listbox"`, cards as `role="option"` with `aria-selected`
- Auth methods: `role="radiogroup"`, cards as `role="radio"` with `aria-checked`
- Model toggles: `<input type="checkbox" role="switch">` with `aria-label`
- Loading: `role="status"`, `aria-live="polite"`
- Errors: `role="alert"`, `aria-live="assertive"`

## Testing Strategy

### Unit Tests (Vitest)

| File | Scope |
|------|-------|
| `src/lib/opencode/client.server.test.ts` | Extended: new proxy functions, timeout, error handling |
| `src/routes/admin/opencode/providers/server.test.ts` | New: auth guard, proxy behavior, no secrets in response |
| `src/routes/admin/opencode/providers/[id]/auth/server.test.ts` | New: device auth flow, poll session management |
| `src/routes/admin/opencode/model/server.test.ts` | New: model get/set, env write |
| `src/lib/server/helpers.test.ts` | Extended: `localhost` SSRF regression |

### Mocked E2E (Playwright)

| File | Scope |
|------|-------|
| `e2e/provider-models-ui.test.ts` | New: sheet open/close, provider list render, model toggles, connect flow |

### Integration E2E (Playwright, requires stack)

| File | Scope |
|------|-------|
| `e2e/opencode-providers.test.ts` | New: live provider list, no secrets in response, 401 without token |

## Implementation Order

### Phase 1: Fix & Foundation (no UI changes)
1. Fix `/providers` → `/provider` in `client.server.ts`
2. Remove `writeOpenCodeProviderConfig()` calls from assignment and connection save
3. Deprecate `writeOpenCodeProviderConfig()` in lib
4. Add `proxyToOpenCode` helper to `client.server.ts`
5. Add `localhost` SSRF fix to `helpers.ts`
6. Probe live OpenCode API endpoints

### Phase 2: Server Routes
7. Add `GET /admin/opencode/providers` route
8. Add `GET /admin/opencode/providers/[id]/models` route
9. Add `GET/POST /admin/opencode/model` route
10. Add `POST /admin/opencode/providers/[id]/auth` route
11. Add `GET /admin/opencode/providers/[id]/auth/poll` SSE route
12. Add client-side API wrappers in `providers-api.ts`

### Phase 3: UI Components
13. Add CSS tokens and component classes to `app.css`
14. Build `ModalSheet.svelte` (reusable sheet container)
15. Build `ManageModelsSheet.svelte` (model toggles + defaults)
16. Build `ConnectProviderSheet.svelte` (provider picker grid)
17. Build `ConnectDetailSheet.svelte` (auth form)
18. Build `ProviderAuthDevice.svelte` (device auth polling)
19. Add type definitions to `types.ts`

### Phase 4: Integration
20. Wire sheets into `ConnectionsTab.svelte`
21. Add entry point buttons ("Manage Models", "Connect Provider")
22. End-to-end flow testing

### Phase 5: Testing & Polish
23. Unit tests for all new server routes
24. SSRF regression tests
25. Mocked E2E tests for UI flows
26. Integration E2E tests (with stack)
27. Keyboard navigation and accessibility audit
28. API spec documentation update

## Acceptance Criteria

- [ ] Provider/model configuration UI is available and functional during setup
- [ ] All configuration and connection actions work via the OpenCode server API (proxied)
- [ ] Styling, flow, and modals are consistent with setup wizard
- [ ] No duplicate provider/model state is created
- [ ] CORS/auth handled correctly via server-side proxy
- [ ] Error states, loading states, and keyboard navigation are handled
- [ ] No secrets leak through client bundles, logs, or API responses
- [ ] `writeOpenCodeProviderConfig()` broken calls are removed
- [ ] All existing tests continue to pass
