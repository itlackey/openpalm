# UI Host/Client Runtime Refactor Plan

**Date:** 2026-06-19 (revised 2026-07-06)
**Status:** RATIFIED — Phases 0–4 (+1.5) landed; Phases 5–6 re-scoped per `docs/technical/ui-client-split-assessment.md`
**Repo:** `itlackey/openpalm`, branch `main`
**Related issues:** #486 (remote-only install), #435 (guardian authn), #433 (guardian state), #488 (mDNS), #506 (styling), #509 (RuntimeContext), #510 (assistant-container), #511 (PWA), #555 (client extraction), #556 (openpalm admin), #557 (guardian TLS + CORS)

> **Revision note (2026-07-06).** The original draft shipped one `adapter-node` build to
> every runtime mode. That scope is revised: the product is still **one UI**, but it ships
> as **two artifacts** — the host control plane (`@openpalm/ui`, unchanged) and a thin
> static client (`@openpalm/client`) for chat/connections/PWA. Rationale, options
> considered, and evidence: `docs/technical/ui-client-split-assessment.md`. Phases 1–4
> are unchanged. Sections marked **[as-landed]** correct implementation details that
> drifted between the 2026-06-19 draft and the code that actually shipped in Phase 0 /
> the entrypoint scaffolding.

---

## 1. TL;DR

OpenPalm splits the UI into three capability-scoped surfaces:

1. **Host Control Plane** — Electron/host SvelteKit process. Docker, lifecycle, secrets, OP_HOME.
2. **Assistant Control Plane** — where the assistant is reachable but host is not. Chat + assistant settings.
3. **Connection Control Plane** — all modes. Manage connections, switch assistants, authenticate to endpoints.

The current code collapses all of this into `features.admin`, `/admin/*`, `/splash`. That cannot express "chat + assistant settings but no host management" or "PWA connection manager."

**Two artifacts, one product:**

- **`@openpalm/ui`** (existing, `adapter-node`) — the **host app**: setup wizard, `/host`
  admin, connection CRUD, Docker lifecycle. Privileged, loopback-only, served by the
  harness (Electron or `openpalm admin`). Bundles `@openpalm/lib`.
- **`@openpalm/client`** (new, `adapter-static` + `@vite-pwa/sveltekit`) — the **client
  app**: chat, connection switching, assistant settings views. Unprivileged, no
  `@openpalm/lib`, one transport: talk to a guardian/OpenCode base URL with credentials.
  Installable as a PWA from two origins (localhost, official hosted URL — §6.10).
- **`packages/ui-kit`** — shared components/icons/theme, raw-source workspace package,
  inlined at build time by both apps. Not published.

### Simplicity guardrails (non-negotiable UX constraints)

- **Default flows never make TLS a user task.** Desktop installs from
  `http://127.0.0.1:<port>` (secure context, no certificates). Phones install from the
  official hosted URL, which is TLS-terminated centrally.
- **"Install → open → chat."** Adding a connection is paste-a-URL-and-code (or scan a QR
  from the host app); no config files, no cert stores, no port math.
- **Two apps, not N.** No further UI packages beyond `client` and `ui-kit`. The
  assistant-settings write API in container mode is a minimal shim, not a third app —
  and it is an optional follow-up slice, not a launch requirement.

### Standard artifact delivery pattern

Every updatable component follows the same pattern. This is the design standard for the whole stack:

| Component | Package | Version strategy | Runtime install | Containers |
|---|---|---|---|---|
| Host UI | `@openpalm/ui` | Exact pin: `OP_UI_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | — (host process) |
| Client UI — **landed** (#555/#510) | `@openpalm/client` | Exact pin: `OP_CLIENT_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | assistant |
| Skeleton / OP_HOME seed | `@openpalm/skeleton` | Exact pin: `OP_SKELETON_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | assistant, guardian |
| Guardian | `@openpalm/guardian` | Exact pin: `OP_GUARDIAN_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | guardian |
| Portal (discord) | `@openpalm/portal-discord` | Exact pin: `OP_PORTAL_DISCORD_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | portal |
| Portal (slack) | `@openpalm/portal-slack` | Exact pin: `OP_PORTAL_SLACK_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | portal |
| opencode, akm-cli, claude-code, … | per-tool npm packages | Range (`^minor`) via the baked tools `package.json`, per-tool env override | `bun update` | assistant, guardian |

**Two version strategies, one delivery mechanism:**

- **Exact pin** — components where a specific version must be matched at the API or data level: UI/client (RuntimeContext contract version), skeleton (`SHIPPED_DEFAULT_HASHES` hash values), guardian (security boundary, operator must explicitly choose a version). Fail loudly if version cannot be resolved.
- **Range (`^minor`)** — all tools. **[as-landed]** Tool ranges are declared in a
  `package.json` baked into the image at `/opt/openpalm/tools/package.json` (source:
  `containers/assistant/tools/package.json`), bind-mounted from
  `OP_HOME/data/assistant/tools` at runtime, and advanced with `bun update --production`.
  This supersedes the draft's `tools.json`-in-skeleton + `bun add -g` design — the
  landed pattern gets lockfile semantics and per-tool pinning by editing one file, with
  no magic env-key normalization.

**Key principles:**
- One UI *product*, two *artifacts*. The host app is the privileged control plane; the client app is a pure API consumer. Neither ships the other's code.
- Assistant image is a thin host — pulls `@openpalm/client` and `@openpalm/skeleton` from npm at startup.
- Containers carry no bundled content; content is versioned and delivered separately.
- Capabilities are resolved from server context + client context by one function per app. The client app can never resolve `host:*` capabilities — structurally, not by branching.

---

## 2. Decisions recorded

| Question | Decision |
|---|---|
| Skeleton delivery | `@openpalm/skeleton` npm package — **landed** (#508); see §6.7 for the as-landed resolution chain |
| Skeleton version coupling | Hard: skeleton version === platform version. No `latest` in production. `isUnmodifiedDefault` hashes depend on this. |
| Host/client split | **Ratified 2026-07-06** — extract `packages/client` + `packages/ui-kit`; `packages/ui` remains the host control plane. See `ui-client-split-assessment.md`. |
| `assistant-container` UI deployment | `@openpalm/client` pulled from npm at container startup (was: `@openpalm/ui`) |
| `assistant-container` skeleton deployment | `@openpalm/skeleton` pulled from npm at container startup — **landed** in `entrypoint.sh` |
| `assistant-container` process model | One image, co-processes: static client (+ optional settings shim) + OpenCode |
| PWA build approach | `packages/client`: `adapter-static` + `@vite-pwa/sveltekit`. Full client UI; host features are absent from the artifact, not hidden. |
| PWA install origins | **Two primary paths:** (1) localhost — harness/CLI serves the client on a stable loopback port (secure context, zero TLS setup); (2) official hosted URL (e.g. `app.openpalm.dev`) — canonical TLS-terminated origin, one install for phones/tablets. |
| Guardian TLS + CORS | Own workstream. Hard prerequisite for hosted-origin → LAN connections (mixed content) and for any phone → guardian connection. Never a manual user task on default paths. |
| PWA/remote auth | Guardian Basic auth matching the OpenCode implementation. Coordinate with #435. No parallel credential mechanism. |
| `host-ui` mode / `openpalm admin` | Ship **early** (Phase 1.5): CLI serves the host app with admin enabled, loopback-only, existing password auth. |
| `clientMode` detection | Client-side only: `matchMedia('(display-mode: standalone)')` + `navigator.userAgent`. Not server-computed. |
| Capability resolution | `effectiveCapabilities = resolve(serverCaps, clientCtx)`. One function, one file (per app). |
| Legacy `/admin` route lifetime | No alias. `/admin/*` → 404 when `/host/*` ships. <10 installs, no audience to protect. |
| `endpoints.json` rename | Do not rename. Add `kind` field. Internal model uses "connection" language. |
| Milestones | 0.13.0: Phases 0–4 + 1.5. 0.14.0 candidates: Phases 5–6 (client extraction, assistant-container, PWA) + TLS workstream — re-split if 0.13.0 gets heavy. |

---

## 3. Standard artifact delivery pattern — implementation contract

All runtime-installed packages follow this contract. When adding a new installable component, use this as the template.

### Version resolution

```ts
function resolveArtifactVersion(
  envOverride: string | undefined,   // e.g. process.env.OP_SKELETON_VERSION
  platformVersion: string | undefined, // from PLATFORM_VERSION in lib
): string {
  if (envOverride?.trim()) return envOverride.trim();
  if (platformVersion?.trim()) return platformVersion.trim();
  throw new Error(
    `Cannot resolve artifact version. Set OP_<COMPONENT>_VERSION or ensure PLATFORM_VERSION is defined.`
  );
  // NOTE: never fall back to 'latest' in production
}
```

### Source resolution (skeleton / all file-seeding packages) — **[as-landed]**

The landed chain (`packages/lib/src/control-plane/ui-assets.ts`, `resolveLocalOpenpalmDir()`)
has five strategies, not the draft's three:

```
1. OPENPALM_REPO_ROOT env var → ${root}/packages/skeleton/   (dev mode — keep forever)
2. OPENPALM_SKELETON_DIR env var → Electron extraResources dir (set by Electron main)
3. require.resolve('@openpalm/skeleton/package.json') → package dir (CLI bundled dep)
4. import.meta.url source-relative → repo tree (bun run / bun test)
5. null → applyHomeSeed downloads @openpalm/skeleton from the npm registry
```

The GitHub `raw.githubusercontent.com` fallback is **gone** (replaced by the npm registry
download in step 5). The draft's "remove Electron extraResources skeleton" item was **not**
adopted — the extraResources bundle was kept as step 2 so a fresh Electron install works
offline before any npm fetch. This is deliberate; do not "clean it up."

### Install script shape (entrypoint.sh) — **[as-landed]**

`containers/assistant/entrypoint.sh` implements `install_runtime_artifacts()` with these
properties (which supersede the draft sketch):

- Exact-pinned artifacts (`@openpalm/ui` today → `@openpalm/client` after Phase 5;
  `@openpalm/skeleton`) resolve `OP_*_VERSION` → `PLATFORM_VERSION` → **hard error**.
- An install **failure after version resolution** logs an ERROR and continues with the
  existing on-disk artifact if present (warm restart resilience) — the draft's
  "hard error on any install failure" was softened deliberately: a registry blip must not
  brick a previously-working container. Cold start with no artifact still fails visibly
  (the co-process is skipped with a loud log line).
- npm cache lives under the bind-mounted assistant HOME
  (`/home/opencode/.cache/openpalm-npm`), so `--prefer-offline` hits a persistent cache.
  The draft's named `openpalm-artifact-cache` volume was not needed.
- Tools: `bun update --cwd /opt/openpalm/tools --production` against the baked/bind-mounted
  `package.json` (see §1). Tool failures warn and never block container start.

---

## 4. Target scenario matrix

### 4.1 Server host modes

| `hostMode` | Artifact | What it is | What it provides |
|---|---|---|---|
| `electron-host` | `@openpalm/ui` | Electron launches/supervises the SvelteKit Node process on the local machine | Host + Assistant + Connections |
| `host-ui` | `@openpalm/ui` | `openpalm admin` serves the same process without Electron chrome | Host + Assistant + Connections (no Electron IPC) |
| `assistant-container` | `@openpalm/client` | Static client served from the assistant image, co-running with OpenCode | Chat + assistant settings (single locked local connection) |
| `pwa-static` | `@openpalm/client` | Static client served from localhost (harness) or the official hosted URL | Connections management + chat |

### 4.2 Client display modes

| `clientDisplayMode` | How detected | Restrictions |
|---|---|---|
| `electron` | `navigator.userAgent` contains `Electron` | None — unlocks all server-provided caps |
| `standalone-pwa` | `matchMedia('(display-mode: standalone)')` | Connection management only unless server is `assistant-container` |
| `browser` | Default | Same as `standalone-pwa` for now |

### 4.3 Capability matrix

| `hostMode` | `clientDisplayMode` | Effective capabilities |
|---|---|---|
| `electron-host` | `electron` | ALL |
| `host-ui` | `browser` | ALL (minus Electron IPC features) |
| `assistant-container` | `browser` / `standalone-pwa` | `chat`, `assistant-settings:read/write` |
| `pwa-static` | `standalone-pwa` / `browser` | `connections:manage`, `connections:switch`, `chat` (if connected), `pwa:install` |

**Future extension point:** `pwa-static` + remote connection with `grantedCapabilities` → add `assistant-settings:read/write` for that connection. `grantedCapabilities` must be verified server-side by the connected instance — the client cannot self-grant.

**Note on the client app:** the client has no privileged server of its own. Its "server
capabilities" come from the *connected instance's* `/api/runtime` response (assistant-
container mode) or are the static `pwa-static` baseline. `resolveCapabilities()` in the
client therefore operates on (baseline ∪ connection-granted) × display mode — same
function shape, smaller input space, and `host:*` capabilities do not exist in its
type-space at all.

---

## 5. Current architecture problems

**A — one `admin` boolean cannot express the matrix.** `FeatureFlags { admin: boolean }` cannot represent PWA connection management without host, or assistant-container persona editing without host stack access.

**B — connection management locked to `/admin`.** PWA and remote scenarios need connection management without host admin.

**C — `/proxy/assistant/*` requires host admin auth.** Wrong for assistant-container and PWA.

**D — landing logic is host-centric.** Root always redirects to `/splash` which computes local stack state. Wrong for assistant-container and PWA.

**E — host/origin checks hard-coded to loopback.** Incompatible with assistant-container URL or PWA.

**F — assistant settings mix host and assistant concerns.** Persona (assistant-scoped) and `OP_PROJECT_NAME` / bind address (host-scoped) are in the same tab.

**G — skeleton delivery is fragile.** ~~Five-step fallback ladder ending in a GitHub raw URL.~~ **RESOLVED** by #508 (Phase 0): `@openpalm/skeleton` npm package + the §3 resolution chain.

**H — chat transport assumes a privileged same-origin server.** The chat client calls
`/proxy/assistant/*` on its own origin with the `op_session` cookie; the server resolves
the active endpoint per request. A PWA on a phone has no such server: it needs client-held
connections and direct cross-origin calls to a guardian with Basic/Bearer auth. This is
the structural reason the client is a separate artifact — one app would carry both
transports behind mode branches.

---

## 6. Target architecture

### 6.1 Runtime context model

```ts
export type UiHostMode =
  | 'electron-host'
  | 'host-ui'
  | 'assistant-container'
  | 'pwa-static';

export type Capability =
  | 'chat'
  | 'connections:read'
  | 'connections:manage'
  | 'connections:switch'
  | 'connections:single'
  | 'assistant-settings:read'
  | 'assistant-settings:write'
  | 'host:setup'
  | 'host:stack:read'
  | 'host:stack:write'
  | 'host:containers'
  | 'host:addons'
  | 'host:updates'
  | 'host:logs'
  | 'host:secrets'
  | 'host:recovery'
  | 'host:akm-sharing'
  | 'pwa:install';

export type ServerRuntimeContext = {
  version: 2;
  hostMode: UiHostMode;
  serverCapabilities: Capability[];
  publicBaseUrl: string;
  uiVersion: string;
  skeletonVersion: string;
  activeConnectionMode: 'single' | 'multi';
  routes: {
    chat?: string;
    connections?: string;
    assistantSettings?: string;
    host?: string;
    setup?: string;
  };
  security: {
    hostAdminLoopbackOnly: boolean;
    requiresHttpsForRemoteConnections: boolean;
    csrfMode: 'loopback-origin' | 'same-site' | 'bearer-token';
  };
};

export type ClientDisplayMode = 'electron' | 'standalone-pwa' | 'browser';

export type ActiveConnectionContext = {
  kind: ConnectionKind;
  id: string;
  grantedCapabilities?: Capability[];
};

export type ClientContext = {
  displayMode: ClientDisplayMode;
  activeConnection?: ActiveConnectionContext;
};

export type RuntimeContext = ServerRuntimeContext & {
  clientContext: ClientContext;
  effectiveCapabilities: Capability[];
};
```

In the **client app**, the `host:*` members are absent from its local `Capability` union —
the narrowing is enforced by the type system, not by runtime filtering.

### 6.2 Capability resolution — one function

```ts
// lib/runtime-context.svelte.ts — the ONLY place capability logic lives

export function resolveCapabilities(
  serverCaps: Capability[],
  clientCtx: ClientContext
): Capability[] {
  const { displayMode, activeConnection } = clientCtx;

  if (displayMode === 'electron') return serverCaps;

  if (serverCaps.includes('host:stack:read') && displayMode === 'browser') {
    return serverCaps.filter(c => !isElectronOnlyCap(c));
  }

  if (serverCaps.includes('connections:single')) {
    // assistant-container: chat + assistant settings
    return serverCaps.filter(c => c === 'chat' || c.startsWith('assistant-settings'));
  }

  // pwa-static: connections + chat
  let caps = serverCaps.filter(c =>
    c.startsWith('connections') || c === 'chat' || c === 'pwa:install'
  );

  // Extension point: active connection may grant additional capabilities
  if (activeConnection?.grantedCapabilities) {
    caps = [...new Set([...caps, ...activeConnection.grantedCapabilities])];
  }

  return caps;
}

function isElectronOnlyCap(_c: Capability): boolean {
  return false; // reserved for future Electron IPC-dependent features
}

export const runtimeContext = $state<RuntimeContext>(...);

export function hasCapability(cap: Capability): boolean {
  return runtimeContext.effectiveCapabilities.includes(cap);
}
```

`hasCapability(cap)` is the only check components call. No `if (features.admin)` anywhere.

### 6.3 Client context — browser-side only

```ts
// lib/client-context.ts
export function detectClientDisplayMode(): ClientDisplayMode {
  if (typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent)) return 'electron';
  if (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches) return 'standalone-pwa';
  return 'browser';
}
```

Initialized in `+layout.svelte`. Never server-computed.

### 6.4 API namespace split

| Namespace | Purpose | Served by | Auth |
|---|---|---|---|
| `/api/runtime` | Server runtime context (+ contract-version handshake for remote clients) | host app; assistant-container shim | Public — no auth |
| `/api/connections/*` | Connection list, active connection, validation | host app | `connections:manage` capability |
| `/api/assistant/*` | Assistant-owned settings | host app; assistant-container shim (optional slice) | `assistant-settings:write` capability |
| `/api/host/*` | Host stack lifecycle, privileged ops | host app only | `host:stack:write` + loopback-only |
| `/proxy/assistant/*` | Same-origin assistant broker | host app only | Same-origin cookie |

The client app calls guardian/OpenCode APIs **directly** (Basic/Bearer per connection);
it has no privileged namespaces of its own.

**No `/admin/*` alias.** With <10 installs the alias-for-one-release hedge is unnecessary overhead. `/admin/*` becomes 404 when `/host/*` ships.

### 6.5 Landing resolver

```ts
export function resolveLanding(ctx: RuntimeContext, state: LaunchState): string {
  if (hasCapability('host:setup')) {
    if (state.migration.status === 'pending') return '/attention';
    if (state.local.state === 'not_installed') return '/setup';
    if (state.local.state === 'setup_incomplete') return '/setup';
    if (state.local.state === 'installed_offline') return '/host';
    if (state.local.state === 'installed_broken') return '/host?tab=diagnostics';
    return '/chat';
  }
  if (ctx.hostMode === 'assistant-container') return '/chat';
  if (ctx.hostMode === 'pwa-static') {
    return state.connections.length === 0 ? '/connections/new' : '/chat';
  }
  return '/chat';
}
```

### 6.6 Connection model

```ts
export type ConnectionKind = 'local-opencode' | 'remote-opencode' | 'openpalm-client-api';

export type ConnectionEntry = {
  id: string;
  label: string;
  kind: ConnectionKind;
  url: string;
  auth: { mode: 'none' | 'basic' | 'bearer'; secretRef?: string; };
  isDefault?: boolean;
  locked?: boolean;
  grantedCapabilities?: Capability[];
};
```

`endpoints.json` is NOT renamed. `kind` field added. Internal model uses "connection" language.
In the client app, connections live in IndexedDB (offline-readable); in the host app they
stay in `endpoints.json` under `OP_HOME/config/`.

**Pairing UX (simplicity guardrail):** the host app's `/connections` page can mint a
one-time pairing payload (guardian URL + short-lived code, rendered as QR + copyable
string); the client's `/connections/new` accepts paste-or-scan. No manual credential
assembly for non-technical users. (Design detail lands with Phase 6; guardian side
coordinates with #435.)

### 6.7 `@openpalm/skeleton` package — **[as-landed]**

Landed in #508. What shipped (differences from the draft noted):

```
packages/skeleton/
  package.json          # name: "@openpalm/skeleton", no main, no build, no deps
  manifest.json         # [{relPath, category: 'managed'|'guardian-managed'|'seeded'}]
  config/ knowledge/ system/ data/ workspace/   # full OP_HOME seed trees
  openpalm.sh openpalm.ps1
```

- `manifest.json` drives asset categories in `core-assets.ts`; `SHIPPED_DEFAULT_HASHES`
  and `isUnmodifiedDefault()` preserved byte-for-byte. ✅ (as designed)
- Source resolution: the five-strategy chain in §3 (**not** the draft's three-step chain;
  Electron extraResources retained deliberately).
- `tools.json` was **not** added to the skeleton — tool ranges live in the baked
  `containers/assistant/tools/package.json` instead (§1, §3).
- `.openpalm/` in the repo root is a README-only stub. ✅
- `@openpalm/skeleton` is a pinned dep of `packages/cli`. **Follow-up:** the pin
  (`0.12.18` at time of writing) must be advanced by the release process in lockstep with
  `PLATFORM_VERSION` — verify `platform-release.yml` does this before each release.

### 6.8 Authentication model

| Surface | Auth |
|---|---|
| Host Control Plane | Existing `op_session` cookie, `HttpOnly`, `SameSite=Strict`, loopback-only. Unchanged. |
| Assistant Control Plane | Guardian Basic auth (matching OpenCode's auth model) |
| Connection Control Plane | Host app: host admin session for writes. Client app: per-connection credentials in IndexedDB, capability-gated reads |
| PWA / remote clients | Guardian Basic auth aligned with #435 Bearer seam; HTTPS required for non-loopback targets from the hosted origin |

### 6.9 `assistant-container` mode — **[as-landed + re-scoped]**

**Already landed in `containers/assistant/entrypoint.sh`:** `install_runtime_artifacts()`
(exact-pin resolution, npm install of UI + skeleton, tools via `bun update`) and
`start_ui()` (co-process launch, `OP_UI_PORT` default 3000). Boot order:
`install_runtime_artifacts → … → start_ui → start_opencode`.

**Not yet landed / known gaps (tracked in #510):**

1. The co-process port is **not published** in any compose file — the UI runs but is
   unreachable from outside the container.
2. `start_ui` exports `OPENCODE_API_URL`, but the UI reads `OP_OPENCODE_URL` /
   `OP_ASSISTANT_URL` — the co-process therefore points at the default
   `http://127.0.0.1:3800` instead of the in-container OpenCode at `:4096`. Wiring bug;
   fix regardless of the re-scope.
3. No mode env (`OP_UI_HOST_MODE`, `OP_UI_SINGLE_CONNECTION`) is set, and no
   skeleton-seed call runs for assistant-scoped config (`seedFromSkeleton()` from the
   draft does not exist in lib).

**Re-scope (ratified):** after Phase 5, the co-process serves **`@openpalm/client`**
(static files) instead of the full host app:

- Slice A (launch): chat with a single locked connection to the local OpenCode. Serving
  the static bundle needs only a minimal static file server (bun is present in the image).
  `/api/host/*` does not exist in the artifact — nothing to 403.
- Slice B (optional follow-up): a **settings shim** — a small co-process endpoint set
  (`/api/runtime`, `/api/assistant/*`) that performs assistant-scoped file writes
  (persona, AKM runtime config). Only this slice needs anything beyond static serving.
  Ship it only when assistant-settings-from-browser is actually wanted.

**Mounts in assistant-container mode (unchanged):**
- `config/assistant/` — read/write
- `config/akm/` — read/write
- No Docker socket
- No broad `OP_HOME` access

### 6.10 PWA mode — **[re-scoped]**

The PWA is `packages/client` (`adapter-static` + `@vite-pwa/sveltekit`: manifest, icons,
Workbox precache of the app shell). Host features are **absent from the artifact**, not
hidden by capability checks.

**Two primary install origins:**

1. **Localhost (desktop, zero-setup).** The harness serves the built client on a stable
   loopback port (stable because PWA identity = origin incl. port). `http://127.0.0.1` is
   a secure context → installable with no certificates. A loopback origin is also exempt
   from mixed-content blocking and sits in the most-trusted Private Network Access tier,
   so it may call plain-HTTP LAN guardians. Entry points: Electron menu / host app button
   ("Install OpenPalm app") and `openpalm app` on the CLI.
2. **Official hosted URL** (e.g. `https://app.openpalm.dev`). CI publishes the same static
   build to a canonical TLS-terminated origin. One install works on any phone/tablet and
   connects to any of the user's instances. Constraints that follow from the platform,
   not from our code:
   - an HTTPS origin cannot call plain-HTTP guardians (mixed content) → **guardian TLS
     workstream is a hard prerequisite for this path** (Tailscale `ts.net` certs are the
     recommended default; Caddy with a user domain as the alternative);
   - guardian must send CORS headers for the official origin (allowlist, configurable);
   - version skew is handled by the `/api/runtime` contract-version handshake — the
     hosted client degrades gracefully against older instances.

Offline behavior: app shell + connection records (IndexedDB) available offline; chat
requires connectivity. Since the client is static and unauthenticated at the origin level,
the service worker never caches credentialed responses.

**Phone reality check:** a phone can only reach a guardian over TLS (both install paths —
the hosted origin because of mixed content; and any non-loopback origin is not installable
over plain HTTP anyway). The desktop/localhost path is the only truly TLS-free path, which
is why it is the default for the machine that runs the stack, and the hosted path + TLS
workstream is the mobile story.

### 6.11 `packages/client` and `packages/ui-kit`

```
packages/client/            # @openpalm/client — published, exact-pin delivery
  svelte.config.js          # adapter-static, SPA fallback
  vite.config.ts            # @vite-pwa/sveltekit
  src/routes/
    chat/                   # moved from packages/ui (after Phase 3/4 decoupling)
    connections/            # client-side connection manager (IndexedDB)
    assistant/settings/     # visible only when the connection grants it
  src/lib/
    transport/              # ONE transport: guardian/OpenCode base URL + credentials

packages/ui-kit/            # raw-source workspace package — NOT published
  src/lib/components/       # common/, icons/, chrome primitives shared by ui + client
  src/lib/theme/            # tokens, app.css design vocabulary (coordinates with #506)
```

Rules:
- `client` has **no dependency on `@openpalm/lib`** and no `src/lib/server/`.
- `ui-kit` contains no stores with server assumptions — presentational components,
  icons, and theme only. The `endpoints-state` ↔ `chat-state` coupling gets untangled in
  Phases 2–3 *before* extraction, so the move is file relocation, not surgery.
- `packages/ui` keeps its chat surface only until the client reaches parity inside
  Electron (the harness serves the client build alongside the host app), then deletes it.

---

## 7. Implementation phases

Phases are implementation ordering (code dependencies), not release milestones. 0.13.0
carries Phases 1–4 + 1.5; the client extraction (5–6) and TLS workstream follow — pull
them into 0.13.0 only if it stays light.

### Phase 0 — Baseline + skeleton package — ✅ DONE (#508)

Landed with the deltas recorded in §3/§6.7 (five-strategy resolution, extraResources
retained, tools via baked `package.json`, npm-registry cold-start download replacing the
GitHub raw fallback). Outstanding from the original Track A: Playwright smoke tests and
`docs/technical/ui-route-map.md` were **not** produced — fold them into Phase 3, where the
route structure they document actually changes.

### Phase 1 — RuntimeContext v2, no UI change (#509) — ✅ DONE

**As-built:** `ServerRuntimeContext` + `resolveCapabilities()` landed inside the existing
`lib/server/features.ts` (filename kept; `FeatureFlags` replaced). The interim
`features.admin` alias was carried through Phases 1–3 and removed entirely in Phase 4.

**Files:** `lib/server/features.ts`, `lib/types.ts`, `routes/+layout.server.ts`, `lib/runtime-context.svelte.ts`, `lib/client-context.ts`, `routes/api/runtime/+server.ts`

1. Replace `FeatureFlags` with `ServerRuntimeContext`. Keep `features.admin` derived alias until migration completes.
2. Add `computeServerRuntimeContext(event)`, `resolveCapabilities(serverCaps, clientCtx)`, `hasCapability(cap)`.
3. Return `serverRuntimeContext` from `+layout.server.ts`.
4. Initialize `clientContext` in `+layout.svelte` (client-only; detect display mode; wire active connection).
5. Derive `effectiveCapabilities` reactively.
6. Add `/api/runtime` endpoint (public, no auth) — include the contract version used by the future hosted-client handshake.

Acceptance: existing routes unchanged; `features.admin` alias works; capability matrix correct for all current combinations.

### Phase 1.5 — `openpalm admin` (host-ui mode) (#556) — ✅ DONE

**As-built:** as designed; how-it-works docs now record the three admin access paths
(Electron, `openpalm admin`, dev-only `OP_ENABLE_ADMIN=1`) and drop the stale
`openpalm ui serve` reference.

1. CLI: `openpalm admin` (and/or a flag on the default serve path) launches the existing
   UI server with the admin capability enabled (today: `OP_ENABLE_ADMIN=1`; after Phase 1:
   `hostMode: 'host-ui'`), loopback-only, existing `op_session` password auth. Opens the
   browser.
2. No new UI. No new auth. Refuse `OP_ALLOW_REMOTE_SETUP`-style non-loopback binds for
   this mode.

Acceptance: full host management from a browser on the host machine without Electron;
remains loopback-only; `openpalm admin` on a machine without the stack installed lands on
`/setup`.

### Phase 2 — Connection management out of `/admin` (#486) — ✅ DONE

**As-built:** as designed; the `/admin/endpoints` → `/connections` redirect alias shipped
here as planned but was deleted with the rest of `/admin/*` in Phase 4 (§6.4 no-alias rule).

1. Rename internal model "endpoint" → "connection" in UI layer. `endpoints.json` unchanged.
2. Add `kind` to `ConnectionEntry`; default existing records.
3. New routes: `/connections`, `/api/connections/*`. Guard with `connections:manage`.
4. Update chat page link: `/admin/endpoints` → `/connections`.
5. `/admin/endpoints` → redirect to `/connections` (0.13.0 alias).
6. **Untangle for extraction:** break the `endpoints-state` ↔ `chat-state` bidirectional
   import (connection activation emits an event; chat subscribes). This is a hard
   prerequisite for Phase 5.

Acceptance: connection management reachable without `/admin`; host mode unchanged; no data migration; `endpoints-state` no longer imports `chat-state`.

### Phase 3 — Capability-driven landing and navigation — ✅ DONE

**As-built:** `/splash` became `/attention` (the other landing targets already existed as
routes); `docs/technical/ui-route-map.md` produced. New Playwright smoke tests were not
added — the existing e2e stack suites were updated for the new routes instead.

1. Add `resolveLanding(ctx, launchState)`.
2. Split `/splash` into `/attention`, `/setup`, `/host`, `/chat`, `/connections`.
3. Nav reads `runtimeContext.routes` + `hasCapability()`. No `if (features.admin)` checks.
4. **Untangle for extraction:** give the chat surface its own minimal chrome — `Navbar`
   must stop importing chat components/stores into the admin surface. Chat stops importing
   the `$lib/api.js` barrel (direct domain-client imports only).
5. Produce `docs/technical/ui-route-map.md` + Playwright smoke tests (carried from Phase 0).

Acceptance: Electron healthy → chat; capability-driven nav; chat chunk free of admin API clients (verify bundle); route map doc exists.

### Phase 4 — Split Host and Assistant Control Planes (#555) — ✅ DONE

**As-built:** session auth also moved to `/api/auth/{login,logout,session}`; the assistant
namespace split into `/api/assistant/{persona,model,akm}`; `/admin/*` 404s via router
fall-through (route tree deleted, deliberately no hooks alias per §6.4).

1. Move `/admin` → `/host`. No alias — remove immediately. With <10 installs there's no upgrade audience to protect.
2. Split Assistant tab: host stack settings (`host:stack:write`) vs. assistant settings (`assistant-settings:write`).
3. Split AKM: host-level → host-only; assistant-level → assistant-scoped.
4. `requireCapability()` guard on every `/api/host/*` endpoint.

Acceptance: assistant-container can edit persona/AKM but not project name or bind address; host mode unchanged; `/admin/*` returns 404.

### Phase 5 — Extract `packages/client` + `packages/ui-kit` (#555); assistant-container serves it (#510)

*Depends on Phases 2–4 (the untangling steps).*

1. Create `packages/ui-kit` (raw-source workspace package); move `components/common/`,
   `icons/`, theme tokens. Both apps consume it.
2. Create `packages/client` per §6.11; move chat + connections views; implement the single
   transport (direct guardian/OpenCode calls, IndexedDB connections).
3. Harness serves the client build on a stable loopback port; Electron window offers it;
   `packages/ui` chat stays until parity, then dies.
4. Assistant container: `install_runtime_artifacts` pulls `@openpalm/client`
   (`OP_CLIENT_VERSION` → `PLATFORM_VERSION` → error); co-process serves the static bundle
   (Slice A). Fix the `OP_OPENCODE_URL` wiring bug (§6.9). Publish the port in compose
   behind the existing bind-address policy.
5. Release: `@openpalm/client` joins the publish DAG and the exact-pin table. — **landed**
   (P5e: `release.yml` `npm-client` job mirrors `npm-ui`, exact-pin/`needs-build`,
   platform+all stamp/regression-guard/version-sync membership; the client-bundle
   purity gate runs in CI; `@openpalm/ui-kit` stays unpublished).
6. (Optional Slice B, separate issue) settings shim for `/api/assistant/*` writes.

Acceptance: chat in Electron runs from the client build; assistant-container URL serves
chat against local OpenCode with zero host-admin code in the artifact; `docker restart`
with a new `OP_CLIENT_VERSION` picks up the new client.

### Phase 6 — PWA (two install origins) (#511)

*Depends on Phase 5.*

1. `@vite-pwa/sveltekit` in `packages/client`: manifest, icons (192/512 + maskable),
   Workbox app-shell precache.
2. Localhost install path: stable port, install affordances in Electron/host app/CLI
   (`openpalm app`).
3. Hosted install path: CI deploy of the static build to the official URL; `/api/runtime`
   contract-version handshake; connection pairing UX (§6.6).
4. Guardian CORS allowlist for the official origin.
5. IndexedDB connection store; offline shell.

Acceptance: install prompt on desktop from localhost with zero TLS setup; install on a
phone from the official URL; add/switch connections via paste-or-scan pairing; offline
launch shows the shell + saved connections, not a blank page.

### Phase 6.5 — Guardian edge TLS + CORS workstream (#557) — NEW

*Parallel to Phases 5–6; hard prerequisite for hosted-origin → LAN connections.*

1. Recommended default: Tailscale integration docs + `ts.net` cert flow (guided, no cert
   management for the user).
2. Alternative: Caddy front for guardian with a user-owned domain (DNS challenge).
3. Explicit non-goal: asking non-technical users to install a private CA on iOS/Android.
4. `requiresHttpsForRemoteConnections` enforced: the hosted client refuses plain-HTTP
   non-loopback targets with a clear, actionable message (deep-link to the TLS guide).

### Phase 7 — Security hardening

*Depends on Phases 1–6.*

1. Host admin loopback-only checks unchanged.
2. Context-aware origin checks per mode; guardian CORS tests (allowlist enforced).
3. Route guard tests for every `/api/host/*` endpoint (must 403 in non-host modes).
4. Negative tests: assistant-container artifact contains no host-admin code (build
   assertion, not just runtime 403); hosted client cannot reach host APIs.
5. CSP review for both apps; service worker never caches credentialed responses.

### Phase 8 — Release integration

*Depends on all prior phases.*

1. Add `OP_CLIENT_VERSION`, `OP_SKELETON_VERSION` to compose env-file docs and release notes.
2. Verify the release process advances the CLI's pinned `@openpalm/skeleton` dep (§6.7 follow-up).
3. New docs: `docs/technical/ui-runtime-modes.md` (replaces this plan), `docs/technical/artifact-delivery-pattern.md`.
4. Release checklist: smoke-test electron-host, host-ui (`openpalm admin`), assistant-container (with version overrides), localhost PWA install, hosted PWA install.

---

## 8. Non-negotiable rules

1. **`latest` is never a production fallback.** Every component resolves to an explicit version or fails loudly.
2. **`isUnmodifiedDefault` and `SHIPPED_DEFAULT_HASHES` are preserved byte-for-byte.** Skeleton version must equal platform version in production or these hashes diverge and the guardian-managed write policy silently misfires.
3. **Host admin remains loopback-only.** Never weakened.
4. **Assistant container gets no Docker socket and no broad OP_HOME write access.**
5. **APIs enforce capabilities server-side.** `hasCapability()` is UX, not the security boundary. In the client app the stronger form applies: host capabilities are absent from the artifact.
6. **`resolveCapabilities()` is the only place capability logic lives** (one per app). No scattered `if (features.admin)`.
7. **`OPENPALM_REPO_ROOT` dev override is preserved forever.** Essential for local dev loop.
8. **Backup-before-overwrite for managed assets is preserved.** User recovery path for bad skeleton releases.
9. **`grantedCapabilities` on connections must be server-verified at connection-add time.** The client cannot self-grant capabilities.
10. **The client app never bundles `@openpalm/lib` and never holds host credentials.**
11. **TLS is never a manual task on default install paths.** Desktop = localhost (none needed); phone = hosted origin + guided guardian TLS (Tailscale default).

---

## 9. File-level change map

| Area | Current | Change |
|---|---|---|
| Skeleton package | ✅ landed (#508) | Follow-up only: release-time advance of the CLI's pinned dep |
| Feature flags | `lib/server/features.ts`, `lib/types.ts` | Replace with `ServerRuntimeContext` + `resolveCapabilities()` (Phase 1) |
| Client context | (none) | New `lib/client-context.ts` (Phase 1) |
| Layout data | `routes/+layout.server.ts`, `+layout.svelte` | Pass server context; initialize client context + resolved caps (Phase 1) |
| CLI admin | (admin unreachable via CLI) | `openpalm admin` — host-ui mode (Phase 1.5) |
| Landing | `routes/+page.ts`, `routes/splash/*`, `hooks.server.ts` | `resolveLanding()` (Phase 3) |
| Host admin | `routes/admin/*` | Move to `/host`; `host:*` guards (Phase 4) |
| Connections | `routes/admin/endpoints/*`, `endpoints-state.svelte.ts` | Move to `/connections`; rename internal model; break chat-state coupling (Phase 2) |
| Chat chrome | `Navbar.svelte` imports chat stores | Chat gets its own chrome; barrel imports removed (Phase 3) |
| Assistant settings | `AssistantTab.svelte` | Split host stack vs. assistant-owned (Phase 4) |
| AKM | `AkmTab.svelte` | Split assistant-scoped vs. host-only (Phase 4) |
| Shared components | `packages/ui/src/lib/components/{common,icons}` | Move to `packages/ui-kit` (Phase 5) |
| Chat + connections views | `packages/ui/src/routes/{chat,advanced}`, `/connections` | Move to `packages/client` (Phase 5) |
| Assistant image | `containers/assistant/entrypoint.sh`, `Dockerfile` | Pull `@openpalm/client`; fix `OP_OPENCODE_URL` wiring; publish port (Phase 5) |
| PWA | (none) | `@vite-pwa/sveltekit` in `packages/client`; hosted deploy pipeline (Phase 6) |
| Guardian edge | plain HTTP, no CORS | CORS allowlist + TLS workstream (Phases 6, 6.5) |
| Electron main | `packages/electron/src/main.ts` | Pass `OP_UI_HOST_MODE=electron-host`; serve/point at client build (Phases 1, 5) |
| Release DAG | `.github/workflows/release.yml` (the plan's "platform-release.yml") | Add `@openpalm/client` — **landed** (Phase 5/P5e); skeleton pin advance check remains (Phase 8) |

---

## 10. Milestone summary

```
Phase 0 (skeleton package)        ✅ DONE (#508)
Phase 1 (RuntimeContext)          ✅ DONE (#509)
Phase 1.5 (openpalm admin)        ✅ DONE (#556)
Phase 2 (connections + untangle)  ✅ DONE (#486) ──┐
Phase 3 (landing + chrome untangle) ✅ DONE       ─┼─► Phase 5 prerequisites met
Phase 4 (control plane split)     ✅ DONE (#555) ──┘
Phase 5 (client + ui-kit extraction, assistant-container) ─► prerequisite for 6
Phase 6 (PWA, two install origins) ─ needs 5
Phase 6.5 (guardian TLS + CORS)   ─ parallel to 5/6; gates the phone story
Phase 7 (security tests)          ─ needs 1–6.5
Phase 8 (release integration)     ─ needs all
```

0.13.0 target: Phases 1–4 + 1.5 — **complete**. Phases 5–6.5 land in 0.13.0 only if it
stays light; otherwise they open 0.14.0. (The original "all phases in 0.13.0" call
predates the client-split re-scope; the Phase 4 completion re-evaluation point has now
been reached.)

---

## 11. Acceptance criteria

**Capability system:**
- `resolveCapabilities()` is the only capability logic; all components call `hasCapability()` only
- Adding a new capability rule requires editing one function
- Electron gets all caps; assistant-container gets chat + assistant-settings; pwa-static gets connections + chat

**Host modes:**
- Electron app: full host management, all features
- `openpalm admin`: full host management from a browser on the host, loopback-only, no Electron
- Browser to assistant-container URL: chat (+ assistant settings when Slice B ships); no host-admin code in the artifact
- PWA (localhost): installable on the host machine with zero TLS setup
- PWA (hosted): installable on a phone from the official URL; connects only to HTTPS guardians; pairing is paste-or-scan

**Versioning:**
- `OP_CLIENT_VERSION` / `OP_SKELETON_VERSION` override the versions used by the assistant container
- Neither ever silently falls back to `latest`
- `docker restart` with a new version env var picks up the new artifact
- Hosted client ↔ instance skew is handled by the `/api/runtime` contract handshake

**Release:**
- electron-host, host-ui, assistant-container, and both PWA install paths smoke-tested before publishing each release
