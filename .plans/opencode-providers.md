# OpenCode Provider Configuration UI — SvelteKit Implementation Plan
# (Revised after deep-dive integration analysis — 2026-02-27)

## Goal

Build a SvelteKit 2 / Svelte 5 web UI that lets users manage their OpenCode LLM provider
configuration: browse supported providers, enter API keys, initiate OAuth flows, and see
connection status. All business logic lives in the OpenCode server; our app is a **thin
presentation layer** that calls the existing HTTP API.

---

## 1. Architecture Overview

```
┌─────────────────────────────┐
│   SvelteKit App (our code)  │
│                             │
│  +page.svelte (UI/layout)   │
│  +page.server.ts (load)     │
│  +server.ts (API proxy)     │
│                             │
│  Responsibilities:          │
│  • Render provider list     │
│  • Show auth methods per    │
│    provider (API key/OAuth) │
│  • Capture API key input    │
│  • Drive OAuth modal flow   │
│  • Display connection status│
│                             │
└────────────┬────────────────┘
             │  HTTP (fetch to http://assistant:4096)
             ▼
┌─────────────────────────────┐
│   OpenCode Server           │
│   (opencode web, port 4096) │
│                             │
│  Responsibilities:          │
│  • Provider discovery       │
│  • Auth storage (auth.json) │
│  • OAuth authorize/callback │
│  • Config read/write        │
│  • Model listing            │
│  • All business logic       │
└─────────────────────────────┘
```

**Key principle**: Our SvelteKit app owns zero provider logic. It calls OpenCode's REST API
for everything—listing providers, determining auth methods, storing credentials, and handling
OAuth. The only code we write is layout, components, and thin `fetch` wrappers.

---

## 2. Stack Integration Context (Critical — Read Before Building)

### 2a. How Admin Reaches OpenCode

The admin container has `OPENPALM_ASSISTANT_URL=http://assistant:4096` already configured
in `docker-compose.yml`. Both services are on `assistant_net`. OpenCode auth is disabled
(`OPENCODE_AUTH=false`), so no credentials are needed for internal API calls.

**Use `OPENPALM_ASSISTANT_URL` as the base URL** — not a new env var. The existing
`client.server.ts` incorrectly uses `OPENPALM_OPENCODE_URL` (which is never set, causing
silent fallback to a localhost address that doesn't resolve inside the container).

### 2b. OpenCode's Configuration and Storage Layout

OpenCode in the assistant container uses two separate directory types:

| Location (in container) | Host mount | What lives there |
|---|---|---|
| `/opt/opencode/` | None (image-baked) | Core extensions: tools, plugins, skills, opencode.jsonc |
| `/home/opencode/.config/opencode/` | `CONFIG_HOME/opencode/` | User extensions (seeded by `ensureOpenCodeConfig()`) |
| `/home/opencode/.local/share/opencode/` | `DATA_HOME/assistant/.local/share/opencode/` | **auth.json** — stored credentials |
| `/home/opencode/.local/state/opencode/` | `DATA_HOME/assistant/.local/state/opencode/` | Sessions, logs |

`OPENCODE_CONFIG_DIR=/opt/opencode` is intentional. It points OpenCode at the baked-in
core extensions. OpenCode also searches the XDG config home (`~/.config/opencode/`) for
user extensions — which maps to `CONFIG_HOME/opencode/` via the volume mount. Both
directories are merged at runtime (core extensions take precedence).

**auth.json persistence**: OpenCode stores credentials at XDG data home (`~/.local/share/opencode/auth.json`),
which maps to `DATA_HOME/assistant/.local/share/opencode/auth.json` on the host. This is
covered by the `DATA_HOME/assistant:/home/opencode` bind mount and survives container
recreation. No changes to `OPENCODE_CONFIG_DIR` or docker-compose.yml are needed for auth
to persist correctly.

### 2c. Two Credential Stores — Coexisting by Design

The stack has two independent credential stores that serve different scopes:

| Store | Path | Updated by | Consumers |
|---|---|---|---|
| `secrets.env` | `CONFIG_HOME/secrets.env` | Connections page | All containers via env vars (guardian, openmemory, assistant, etc.) |
| OpenCode auth | `DATA_HOME/assistant/.local/share/opencode/auth.json` | Providers page (via OpenCode API) | OpenCode LLM calls only |

Both are valid and complementary:
- **Connections page** = stack-level keys that all services need (e.g. `GUARDIAN_LLM_PROVIDER`)
- **Providers page** = OpenCode-level credential management with full provider discovery,
  OAuth support, and connection status from OpenCode's perspective

OpenCode's `GET /provider` returns `connected: string[]` reflecting providers reachable via
**either** env vars **or** auth.json — so the providers UI shows a unified view regardless
of which store holds the key. When a user adds a key via the providers UI, it goes into
auth.json (sufficient for OpenCode's LLM calls). If that key also needs to reach other
containers (guardian, openmemory), the user sets it via the connections page too.

### 2d. OpenCode API Endpoint Correction

The correct endpoint is `GET /provider` (no trailing `s`). The existing `client.server.ts`
calls `/providers` — this must be fixed.

---

## 3. SvelteKit Project Structure

```
src/
├── lib/
│   ├── opencode/
│   │   ├── client.server.ts       # SDK + fetch wrapper (server-only)
│   │   └── types.ts               # Re-exported SDK types
│   ├── components/
│   │   ├── ProviderCard.svelte    # Single provider display card
│   │   ├── ProviderList.svelte    # Grid/list of all providers
│   │   ├── ApiKeyForm.svelte      # API key input + submit
│   │   ├── OAuthDialog.svelte     # OAuth modal (URL + instructions + code input)
│   │   ├── ConnectionBadge.svelte # Connected/disconnected status pill
│   │   └── ProviderSearch.svelte  # Search/filter providers
│   └── stores/
│       └── providers.svelte.ts    # Svelte 5 reactive state for providers
├── routes/
│   ├── +layout.svelte             # Shell layout
│   ├── +layout.server.ts          # Load OpenCode connection status
│   ├── providers/
│   │   ├── +page.svelte           # Provider list page
│   │   ├── +page.server.ts        # Load providers + auth methods
│   │   └── [id]/
│   │       ├── +page.svelte       # Single provider detail/connect page
│   │       ├── +page.server.ts    # Load provider detail + auth options
│   │       └── connect/
│   │           └── +server.ts     # Form action: POST API key
│   └── api/
│       └── provider/
│           └── [id]/
│               └── oauth/
│                   ├── +server.ts          # POST: initiate OAuth → {url, method, instructions}
│                   └── complete/
│                       └── +server.ts      # POST: complete OAuth → {code?}
└── app.html
```

**Note**: There is no `/oauth/callback` route. OpenCode handles all OAuth callbacks
internally (see Section 4d for the correct flow).

---

## 4. Integration Layer — Thin by Design

### 4a. SDK + Client Setup

Add `@opencode-ai/sdk` to `core/admin/package.json` as a runtime dependency:

```bash
cd core/admin && npm install @opencode-ai/sdk
```

```typescript
// src/lib/opencode/client.server.ts (updated)
import { env } from '$env/dynamic/private'

// OPENPALM_ASSISTANT_URL is already set in docker-compose.yml admin service
// to http://assistant:4096 for production. Falls back to localhost for local dev.
const BASE_URL = env.OPENPALM_ASSISTANT_URL ?? 'http://localhost:4096'

/**
 * Thin typed wrapper around OpenCode's REST API.
 * Uses hand-rolled fetch with typed response shapes derived from the OpenAPI spec
 * at http://<assistant>:4096/doc. Extend as needed.
 *
 * @opencode-ai/sdk is installed as a dependency for type imports and future
 * use (e.g. server-side SDK methods, type generation). Direct HTTP calls are
 * used here to avoid bundling the SDK's server-side runtime into the client.
 */

export type OcProvider = {
  id: string
  name: string
  env?: string[]
}

export type OcProviderListResponse = {
  all: OcProvider[]
  connected: string[]
  default?: OcProvider
}

export type OcAuthMethod = {
  type: 'api' | 'oauth'
  name?: string
}

export type OcAuthorization = {
  url: string
  method: 'auto' | 'code'  // 'auto' = device flow (polls); 'code' = paste-back
  instructions: string
}

async function ocFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`OpenCode ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export const oc = {
  listProviders: () =>
    ocFetch<OcProviderListResponse>('/provider'),

  listAuthMethods: () =>
    ocFetch<Record<string, OcAuthMethod[]>>('/provider/auth'),

  listAuth: () =>
    ocFetch<Record<string, unknown>>('/auth'),

  saveApiKey: (providerID: string, key: string) =>
    ocFetch<boolean>(`/auth/${providerID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'api', key })
    }),

  deleteAuth: (providerID: string) =>
    ocFetch<boolean>(`/auth/${providerID}`, { method: 'DELETE' }),

  oauthAuthorize: (providerID: string, methodIndex: number) =>
    ocFetch<OcAuthorization>(`/provider/${providerID}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerID, method: methodIndex })
    }),

  oauthCallback: (providerID: string, code?: string) =>
    ocFetch<boolean>(`/provider/${providerID}/oauth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(code ? { code } : {})
    })
}
```

### 4b. Server Load Functions (Data Fetching)

```typescript
// src/routes/providers/+page.server.ts
import { oc } from '$lib/opencode/client.server'

export async function load() {
  const [providerData, authMethods] = await Promise.all([
    oc.listProviders(),
    oc.listAuthMethods()
  ])

  return {
    providers: providerData.all,
    connected: providerData.connected,
    authMethods,
    defaults: providerData.default
  }
}
```

### 4c. Form Actions (API Key Submission)

```typescript
// src/routes/providers/[id]/connect/+server.ts
import { oc } from '$lib/opencode/client.server'
import { json } from '@sveltejs/kit'

export async function POST({ params, request }) {
  const { apiKey } = await request.json()
  const result = await oc.saveApiKey(params.id, apiKey)
  return json({ success: result })
}
```

### 4d. OAuth Flow — Device Code and Code-Paste (NOT Traditional Callback)

**Critical context**: OpenCode does NOT use traditional OAuth callback redirect to our
server. Instead it uses two patterns:

| Pattern | `method` field | Example providers | How it works |
|---|---|---|---|
| Device code (RFC 8628) | `"auto"` | GitHub Copilot, OpenAI Codex (headless) | OpenCode polls token endpoint internally; no code input from user |
| Code paste | `"code"` | Anthropic Claude Pro/Max | Redirect goes to provider's servers; user pastes a code back |

Both patterns work in LAN-only Docker deployments. **No public HTTPS callback URL is
needed** on our server. The provider either uses a device verification page (user enters
a code shown in our UI) or redirects to the provider's own hosted callback URL (user
pastes a code shown on the provider's page back into our UI).

There is also a **localhost server** pattern (OpenAI Codex "browser" mode) where OpenCode
starts a local HTTP server at port 1455 inside the assistant container. This works only
when the user's browser is on the same host as OpenCode — in Docker deployments this
requires port 1455 to be exposed. Treat this as unsupported in the initial Docker
deployment and recommend the headless/device-code mode for Codex.

**Admin API routes:**

```typescript
// src/routes/api/provider/[id]/oauth/+server.ts
// POST: initiate OAuth, returns authorization info to the UI
import { oc } from '$lib/opencode/client.server'
import { json } from '@sveltejs/kit'

export async function POST({ params, request }) {
  const { methodIndex } = await request.json()
  const auth = await oc.oauthAuthorize(params.id, methodIndex ?? 0)
  // Return URL + instructions to the client — UI opens the URL in a new tab
  return json(auth)
}
```

```typescript
// src/routes/api/provider/[id]/oauth/complete/+server.ts
// POST: complete OAuth after user action
// For method:"auto" — no body needed, OpenCode polls internally (may take 30–120s)
// For method:"code" — body contains { code: string } pasted by the user
import { oc } from '$lib/opencode/client.server'
import { json } from '@sveltejs/kit'

export async function POST({ params, request }) {
  const body = await request.json().catch(() => ({}))
  const result = await oc.oauthCallback(params.id, body.code)
  return json({ success: result })
}
```

**UI flow (OAuthDialog.svelte):**

1. User clicks "Connect with OAuth" on a provider card
2. Client POSTs to `/api/provider/{id}/oauth` → receives `{url, method, instructions}`
3. Dialog opens showing:
   - Button to open the URL in a new browser tab
   - The `instructions` text verbatim (contains device code or paste prompt)
   - If `method === "code"`: text input for the authorization code + Submit button
   - If `method === "auto"`: spinner with "Waiting for authorization…"
4. For `"code"` method: user opens URL in any browser (on any device), authorizes, gets
   shown a code, pastes it into the dialog
5. For `"auto"` method: user opens URL in their browser, enters the device code shown
   in the dialog
6. Client POSTs to `/api/provider/{id}/oauth/complete`:
   - `"code"` method: sends `{ code }` — OpenCode exchanges it for a token
   - `"auto"` method: sends empty body — OpenCode polls until the device is authorized
7. On success, call `invalidateAll()` to refresh provider connection status

**Important**: The `oauthCallback` for `"auto"` (device code) polls internally and will
block until authorized or timed out (~120s). The fetch request to `/api/provider/{id}/oauth/complete`
must not use a short timeout. The UI should show a loading state for the full duration.

---

## 5. Presentation Layer — Component Design

### 5a. Provider List Page (`/providers`)

The main page shows all available providers in a searchable, filterable grid. Each card
shows the provider name, logo/icon, connection status, and available auth methods.

**Data flow**:
1. `+page.server.ts` loads providers and auth methods from OpenCode
2. `+page.svelte` receives data via `$props()` (Svelte 5)
3. `ProviderSearch` filters the list client-side (no server call needed)
4. `ProviderCard` renders each provider with status

**Key UI states per provider**:
- **Not connected** — Show "Connect" button, auth method options
- **Connected (API key)** — Show green badge, option to disconnect
- **Connected (OAuth)** — Show green badge, account info, option to disconnect
- **Multiple auth methods available** — Show choice (API key vs OAuth method name)

**Context for users**: The Connections page manages stack-level keys (env vars for all
containers). The Providers page manages OpenCode-level auth. Link between them with a
note: "To share a key with all stack services, also add it on the Connections page."

### 5b. Provider Detail Page (`/providers/[id]`)

For providers that need more context (like Bedrock with region/profile config), a detail
page can show expanded options. For most providers this is just the connect form.

**API key flow**:
1. User types API key into `ApiKeyForm`
2. Form submits to `/providers/[id]/connect` (our +server.ts endpoint)
3. That endpoint calls `POST /auth/{providerID}` on OpenCode (writes to auth.json in DATA_HOME)
4. On success, call `invalidateAll()` (SvelteKit re-runs load functions)
5. Provider card updates to "Connected"

**OAuth flow**:
1. User clicks OAuth button, selects OAuth method (if multiple)
2. Client POSTs to `/api/provider/{id}/oauth` → gets `{url, method, instructions}`
3. `OAuthDialog` opens (see Section 4d for full modal flow)
4. On completion, `invalidateAll()` → provider shows as connected

### 5c. Component Responsibilities

| Component | What It Does | What It Does NOT Do |
|-----------|-------------|---------------------|
| `ProviderCard` | Displays name, icon, status badge, connect CTA | No auth logic |
| `ApiKeyForm` | Renders input field, submit button, validation UX | No storage; posts to server route |
| `OAuthDialog` | Shows URL + instructions + code input or spinner | No token handling; delegates to server routes |
| `ConnectionBadge` | Shows connected/disconnected/error state | Pure presentational |
| `ProviderSearch` | Text filter + optional category tabs | Client-side filter only |
| `ProviderList` | Maps provider array → ProviderCard components | No data fetching |

---

## 6. Reactive State (Svelte 5 Runes)

```typescript
// src/lib/stores/providers.svelte.ts
import type { OcProvider, OcAuthMethod } from '$lib/opencode/types'

export class ProviderStore {
  providers = $state<OcProvider[]>([])
  connected = $state<string[]>([])
  authMethods = $state<Record<string, OcAuthMethod[]>>({})
  searchQuery = $state('')

  filtered = $derived(
    this.providers.filter(p =>
      p.name.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
      p.id.toLowerCase().includes(this.searchQuery.toLowerCase())
    )
  )

  isConnected(providerID: string) {
    return this.connected.includes(providerID)
  }

  getAuthMethods(providerID: string) {
    return this.authMethods[providerID] ?? []
  }

  hasOAuth(providerID: string) {
    return this.getAuthMethods(providerID).some(m => m.type === 'oauth')
  }

  hasApiKey(providerID: string) {
    return this.getAuthMethods(providerID).some(m => m.type === 'api')
  }
}
```

---

## 7. Real-Time Updates via SSE (Optional Enhancement)

OpenCode exposes `GET /global/event` as an SSE stream. Subscribe to detect provider
connection changes without polling.

```typescript
// In a layout or provider page component
$effect(() => {
  const es = new EventSource(`${OPENCODE_URL}/global/event`)
  es.onmessage = (e) => {
    const event = JSON.parse(e.data)
    if (event.type === 'provider.connected' || event.type === 'provider.disconnected') {
      invalidateAll() // Re-run load functions
    }
  }
  return () => es.close()
})
```

---

## 8. Configuration & Environment

No new environment variables are needed for the providers UI. The admin already has:

```
OPENPALM_ASSISTANT_URL=http://assistant:4096   # Already in docker-compose.yml admin service
```

This is the only variable `client.server.ts` needs. No separate `OPENCODE_SERVER_URL` or
callback URL configuration is required.

For local development, `OPENPALM_ASSISTANT_URL` defaults to `http://localhost:4096`
when not set, allowing `opencode serve` to be run locally during development.

---

## 9. What We Build vs. What OpenCode Provides

| Concern | Owner |
|---------|-------|
| Provider list (which providers exist) | **OpenCode** (via Models.dev + config) |
| Auth method discovery (API key vs OAuth vs env var) | **OpenCode** (`GET /provider/auth`) |
| Credential storage (`auth.json` in DATA_HOME) | **OpenCode** (`POST /auth/{id}`) |
| OAuth token exchange (device code polling, code exchange) | **OpenCode** (`POST /provider/{id}/oauth/*`) |
| Config file read/write | **OpenCode** (`GET/PATCH /config`) |
| Provider SDK loading (AI SDK packages) | **OpenCode** |
| Model listing | **OpenCode** (`GET /config/providers`) |
| **Rendering the provider grid** | **Us** |
| **API key input form** | **Us** |
| **OAuth modal orchestration (URL display + code input)** | **Us** |
| **Connection status display** | **Us** |
| **Search / filter UI** | **Us** |
| **Responsive layout, styling** | **Us** |

---

## 10. Implementation Phases

### Phase 1: Foundation
- Add `@opencode-ai/sdk` to `core/admin/package.json` (runtime dep)
- Fix `client.server.ts`: use `OPENPALM_ASSISTANT_URL` (not `OPENPALM_OPENCODE_URL`), fix endpoint to `/provider`
- Verify connectivity from admin to OpenCode via the corrected client
- Environment configuration and layout shell

### Phase 2: Provider Browsing
- `/providers` page with server load function
- `ProviderCard` + `ProviderList` + `ConnectionBadge` components
- Search/filter functionality
- Display connected vs. not-connected state
- Navigation link from main admin dashboard

### Phase 3: API Key Authentication
- `ApiKeyForm` component with client-side validation
- `POST /providers/[id]/connect` server route → calls `POST /auth/{id}` on OpenCode
- Success/error feedback
- Disconnect (delete credential) flow

### Phase 4: OAuth Authentication
- `OAuthDialog` component (URL + instructions + conditional code input)
- `POST /api/provider/{id}/oauth` route (initiate, returns authorization info)
- `POST /api/provider/{id}/oauth/complete` route (complete, handles both auto + code)
- Long-running fetch handling for device-code flows (~120s timeout)
- Success state display after OAuth completion

### Phase 5: Polish
- SSE integration for real-time status updates
- Provider category grouping/tabs
- Error handling and retry UX
- Loading skeletons / transitions
- Mobile responsive layout
- Accessibility (keyboard nav, ARIA labels, focus management)
- Note on Connections page linking to Providers page and vice versa

---

## 11. Flags for Architecture / Principle Review

These items don't necessarily violate principles but should be reviewed before or during
implementation:

### FLAG-1: ANTHROPIC_API_KEY Missing from Assistant Container Env

`docker-compose.yml` passes `OPENAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, and
`GOOGLE_API_KEY` to the assistant container, but **not `ANTHROPIC_API_KEY`**. The
connections page allows setting this key, but it never reaches the assistant as an env var.
Anthropic access via env var is silently broken.

**Resolution options**:
- Add `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` to the assistant service env in
  `docker-compose.yml` (consistent with the other providers)
- Leave it as-is and rely on the providers UI's auth.json path for Anthropic (works for
  OpenCode LLM calls, but not for other containers)

**Recommendation**: Add it to docker-compose.yml for consistency. The providers UI doesn't
depend on this fix but it should be addressed as a separate bug.

### FLAG-2: OpenAI Codex Browser OAuth (localhost:1455 Server)

OpenCode's Codex "browser" OAuth method starts a local HTTP server at port 1455 INSIDE the
assistant container. Supporting this in a Docker deployment would require exposing port 1455
from the assistant container. This expands the assistant's network attack surface, which may
conflict with the assistant isolation principle.

**Recommendation**: Do not expose port 1455 in docker-compose.yml. The "headless" Codex
auth method (device code flow) works without this port and is the recommended Docker mode.
Document this limitation in the Providers UI for the Codex provider.

### FLAG-3: Credential Scope Asymmetry (auth.json vs secrets.env)

API keys set via the Providers UI go to OpenCode's auth.json (DATA_HOME — correct tier).
Keys set via the Connections page go to secrets.env (CONFIG_HOME → staged to STATE_HOME
as env vars for all containers). A key in auth.json is NOT visible to guardian or other
containers as an env var.

This is intentional and architecturally sound, but users may be confused about why a key
set in one place doesn't appear in the other. The UI should make this distinction
explicit with a cross-link between the two pages.

**No principle violation** — both stores are within their correct filesystem tiers.

### FLAG-4: OAuth Complete Endpoint Has Long Blocking Duration

For device code OAuth flows (`method: "auto"`), the `POST /api/provider/{id}/oauth/complete`
request will block for up to ~120 seconds while OpenCode polls the token endpoint. This is
acceptable for an internal admin API but:
- The SvelteKit server route must not have a shorter timeout
- The client-side fetch must also not time out early
- Consider using SSE (`GET /global/event`) as an alternative to detect completion
  asynchronously rather than blocking on a single long-running request

**No principle violation** — internal admin API design decision.

---

## 12. Key Decisions & Considerations

**Why server routes instead of direct browser→OpenCode calls?**
The OpenCode server runs on the Docker internal network (`assistant_net`), not accessible
from the user's browser. SvelteKit server routes act as a controlled proxy from the admin
service. This is the same pattern used throughout the existing admin API.

**Why `@opencode-ai/sdk` as a runtime dependency?**
Added for future type-safe integration as the SDK matures. The current implementation uses
hand-rolled fetch for clarity and to avoid bundling the full SDK server runtime. The SDK
is available for future use cases (e.g., event subscriptions, full client generation).

**Why Svelte 5 runes for state?**
The `$state` / `$derived` pattern is already established in this codebase (connections page,
overview tab). Consistent with the project's Svelte 5 approach.

**Why no `/oauth/callback` route?**
OpenCode's OAuth implementations do not redirect back to our server. They either use device
code flow (no callback needed) or redirect to provider-hosted pages (user pastes a code
back). Our admin UI drives this via a modal dialog, not a server-side redirect/callback.

**auth.json persistence is already correct:**
OpenCode stores credentials in `~/.local/share/opencode/auth.json` (XDG data home). The
assistant container mounts `DATA_HOME/assistant` at `/home/opencode`, so this path is
`DATA_HOME/assistant/.local/share/opencode/auth.json` on the host — persisted across
container recreations. No changes to `OPENCODE_CONFIG_DIR` or volume mounts are needed.

---

## 13. Reference Links

### Primary References
- **OpenCode Server API Spec**: `http://localhost:4096/doc` (live OpenAPI 3.1)
- **OpenCode SDK**: `@opencode-ai/sdk` ([npm](https://www.npmjs.com/package/@opencode-ai/sdk))
- **OpenCode Providers Docs**: https://opencode.ai/docs/providers/
- **OpenCode Server Docs**: https://opencode.ai/docs/server/
- **OpenCode Config Docs**: https://opencode.ai/docs/config/
- **SvelteKit Docs**: https://svelte.dev/docs/kit
- **Svelte 5 Runes**: https://svelte.dev/docs/svelte/$state
- **OpenCode Source**: https://github.com/sst/opencode

### Sources That Corrected This Plan

The following sources were used to verify and correct the original plan, specifically around
OAuth flow design (Gap 5), auth.json storage location (Gap 2), and the `OPENCODE_CONFIG_DIR`
semantics.

**OAuth / auth flow (corrected Gap 5 — device code + code-paste, no callback route needed):**
- **GitHub Copilot plugin source** — confirms RFC 8628 device code flow, no redirect URI:
  https://github.com/sst/opencode/blob/dev/packages/opencode/src/plugin/copilot.ts
- **OpenAI Codex plugin source** — shows both localhost-server (port 1455) and device-code
  ("headless") variants:
  https://github.com/sst/opencode/blob/dev/packages/opencode/src/plugin/codex.ts
- **opencode-anthropic-auth npm package** — confirms `method: "code"` (paste-back) flow with
  Anthropic-hosted redirect URI (`https://console.anthropic.com/oauth/code/callback`); no
  local callback server required:
  https://www.npmjs.com/package/opencode-anthropic-auth
- **OpenCode authentication deep-dive (DeepWiki)** — overview of auth mechanisms across
  providers:
  https://deepwiki.com/sst/opencode/4.2-authentication-and-authorization
- **RFC 8628 — OAuth 2.0 Device Authorization Grant** — spec for the device code flow used
  by GitHub Copilot and Codex headless:
  https://datatracker.ietf.org/doc/html/rfc8628
- **opencode-openai-device-auth** — community plugin implementing device code auth for
  OpenAI, confirms device flow approach:
  https://github.com/tumf/opencode-openai-device-auth

**auth.json storage location and OPENCODE_CONFIG_DIR semantics (corrected Gap 2):**
- **OpenCode auth source** (`packages/opencode/src/auth/index.ts`) — shows `auth.json` path
  is derived from XDG data home (`xdgData + "/opencode/auth.json"`), NOT from
  `OPENCODE_CONFIG_DIR`. Confirms persistence via `DATA_HOME/assistant` mount:
  https://github.com/sst/opencode/blob/dev/packages/opencode/src/auth/index.ts
- **OpenCode global/index.ts** — shows `Global.Path.data = path.join(xdgData, "opencode")`:
  https://github.com/sst/opencode/blob/dev/packages/opencode/src/global/index.ts
- **XDG Base Directory Specification** — defines `$XDG_DATA_HOME` (default `~/.local/share`),
  the root of the auth.json path:
  https://specifications.freedesktop.org/basedir-spec/latest/
- **OpenCode Config Docs** — clarifies `OPENCODE_CONFIG_DIR` controls extension/config
  discovery only, not credential storage:
  https://opencode.ai/docs/config/

**Project principles (confirmed OPENCODE_CONFIG_DIR intent):**
- `docs/core-principles.md` Section C — "The assistant container sets
  `OPENCODE_CONFIG_DIR=/opt/opencode` so OpenCode discovers core agents/commands/tools/
  skills/plugins from that directory. Advanced users may bind-mount a host directory over
  `/opt/opencode` to override core behavior."
