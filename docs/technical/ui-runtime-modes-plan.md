# UI Host/Client Runtime Refactor Plan

**Date:** 2026-06-19
**Status:** DRAFT — decisions recorded, ready for implementation
**Repo:** `itlackey/openpalm`, branch `main`
**Related issues:** #486 (remote-only install), #435 (guardian authn), #433 (guardian state), #488 (mDNS), #506 (styling)

---

## 1. TL;DR

The right design is **one UI product with multiple runtime modes and a consistent artifact delivery pattern** across every component of the stack.

OpenPalm splits the UI into three capability-scoped surfaces:

1. **Host Control Plane** — Electron/host SvelteKit process. Docker, lifecycle, secrets, OP_HOME.
2. **Assistant Control Plane** — where the assistant is reachable but host is not. Chat + assistant settings.
3. **Connection Control Plane** — all modes. Manage connections, switch assistants, authenticate to endpoints.

The current code collapses all of this into `features.admin`, `/admin/*`, `/splash`. That cannot express "chat + assistant settings but no host management" or "PWA connection manager."

### Standard artifact delivery pattern

Every updatable component follows the same pattern. This is the design standard for the whole stack:

| Component | Package | Version strategy | Runtime install | Containers |
|---|---|---|---|---|
| UI | `@openpalm/ui` | Exact pin: `OP_UI_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | assistant |
| Skeleton / OP_HOME seed | `@openpalm/skeleton` | Exact pin: `OP_SKELETON_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | assistant, guardian |
| Guardian | `@openpalm/guardian` | Exact pin: `OP_GUARDIAN_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | guardian |
| Portal (discord) | `@openpalm/portal-discord` | Exact pin: `OP_PORTAL_DISCORD_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | portal |
| Portal (slack) | `@openpalm/portal-slack` | Exact pin: `OP_PORTAL_SLACK_VERSION` → `PLATFORM_VERSION` → **error** | `npm install` | portal |
| opencode | `opencode` (npm) | Range: `^minor`, `OP_TOOL_OPENCODE_VERSION` override, from `tools.json` | `bun add -g` | assistant, guardian |
| akm-cli | `akm-cli` | Range: `^minor`, `OP_TOOL_AKM_VERSION` override, from `tools.json` | `bun add -g` | guardian |
| claude-code, codex, … | per-tool npm packages | Range: `^minor`, `OP_TOOL_*_VERSION` override, from `tools.json` | `bun add -g` | assistant |

**Two version strategies, one delivery mechanism:**

- **Exact pin** — components where a specific version must be matched at the API or data level: UI (RuntimeContext contract version), skeleton (`SHIPPED_DEFAULT_HASHES` hash values), guardian (security boundary, operator must explicitly choose a version). Fail loudly if version cannot be resolved.
- **Range (`^minor`)** — all tools: opencode, akm-cli, claude-code, codex, and any future additions. No correctness coupling; auto-updating within minor is desirable and aligns with npm semver expectations. Both containers reading the same `tools.json` from the same skeleton version naturally resolve opencode to the same version — no special lockstep handling needed. Per-tool `OP_TOOL_*_VERSION` env var overrides when an operator needs to pin or skip a specific tool.

**Deviation from range requires written justification in the issue.** If a tool ever needs exact-pinning, document why the `^minor` contract is insufficient before adding the exception.

**Key principles:**
- One UI. The PWA is the same SvelteKit app (adapter-node + service worker), features hidden by resolved capabilities.
- Assistant image is a thin host — pulls `@openpalm/ui` and `@openpalm/skeleton` from npm at startup.
- Containers carry no bundled content; content is versioned and delivered separately.
- Capabilities are resolved from server context + client context by one function. That function is the only extension point.

---

## 2. Decisions recorded

| Question | Decision |
|---|---|
| Skeleton delivery | `@openpalm/skeleton` npm package, no-code, no-build, published alongside platform release |
| Skeleton version coupling | Hard: skeleton version === platform version. No `latest` in production. `isUnmodifiedDefault` hashes depend on this. |
| Skeleton 0.13.0 scope | Full unification in 0.13.0: create package, replace GitHub raw fallback, drop Electron extraResources skeleton, add manifest.json |
| `assistant-container` UI deployment | `@openpalm/ui` pulled from npm at container startup |
| `assistant-container` skeleton deployment | `@openpalm/skeleton` pulled from npm at container startup (same startup script, same version chain) |
| `assistant-container` process model | One image, two co-processes: UI server + OpenCode |
| PWA build approach | One adapter-node build, service worker + manifest in `static/`. Full UI, capabilities hide features. No new pages. |
| PWA/remote auth | Guardian Basic auth matching OpenCode implementation. Coordinate with #435. No parallel credential mechanism. |
| `clientMode` detection | Client-side only: `matchMedia('(display-mode: standalone)')` + `navigator.userAgent`. Not server-computed. |
| Capability resolution | `effectiveCapabilities = resolve(serverCaps, clientCtx)`. One function, one file. |
| Legacy `/admin` route lifetime | No alias. `/admin/*` → 404 when `/host/*` ships. <10 installs, no audience to protect. |
| `endpoints.json` rename | Do not rename. Add `kind` field. Internal model uses "connection" language. |
| Milestones | 0.13.0: Phases 0–4 + skeleton package. 0.14.0: Phases 5–8 (assistant-container + PWA). |

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

### Source resolution (skeleton / all file-seeding packages)

Three steps. No more.

```
1. OPENPALM_REPO_ROOT env var → dev/source mode (keep forever)
2. require.resolve('@openpalm/skeleton/package.json') → resolved package dir (CLI bundled dep, Electron)
3. npm install --prefix <tmpdir> @openpalm/skeleton@<version> → cold start / upgrade path
```

Steps that are gone: `import.meta.url` relative chains, GitHub `raw.githubusercontent.com` download.

### Install script shape (entrypoint.sh)

```sh
# ── Exact-pinned components ───────────────────────────────────────────────────
install_artifact() {
  local pkg="$1" version="$2" prefix="$3"
  echo "Installing ${pkg}@${version}..."
  npm install --prefix "$prefix" "${pkg}@${version}" --omit=dev --prefer-offline
}

install_artifact "@openpalm/ui"       "$OP_UI_VERSION"       /opt/openpalm/ui
install_artifact "@openpalm/skeleton" "$OP_SKELETON_VERSION" /opt/openpalm/skeleton

# ── Range-versioned tools (opencode, akm-cli, claude-code, codex, …) ─────────
# tools.json in the skeleton defines defaults; per-tool env vars override.
# BUN_INSTALL is on the cache volume — warm restarts with unchanged ranges are instant.
export BUN_INSTALL=/opt/openpalm/tools
export PATH="$BUN_INSTALL/bin:$PATH"

TOOL_SECTION="${CONTAINER_ROLE:-global}"   # 'global' for assistant, 'guardian' for guardian
TOOL_PKGS=$(bun -e "
  const tools = require('/opt/openpalm/skeleton/node_modules/@openpalm/skeleton/tools.json')['${TOOL_SECTION}'] || [];
  const pkgs = tools.map(t => t.package + '@' + (process.env[t.envKey] || t.default));
  console.log(pkgs.join(' '));
")

[ -n "\$TOOL_PKGS" ] && bun add -g \$TOOL_PKGS || echo "WARN: some tool installs failed; continuing"
```

Hard error if any exact-pinned artifact install fails. Tool install failures log a warning and do not block the container — one unavailable tool should not prevent the assistant or guardian from starting.

---

## 4. Target scenario matrix

### 4.1 Server host modes

| `hostMode` | What it is | What the server provides |
|---|---|---|
| `electron-host` | Electron launches/supervises the SvelteKit Node process on the local machine | Host + Assistant + Connections |
| `host-ui` | CLI/host process serves SvelteKit without Electron chrome | Host + Assistant + Connections (no Electron IPC) |
| `assistant-container` | SvelteKit UI pulled from npm at startup, co-runs with OpenCode | Assistant settings + single locked local connection |
| `pwa-static` | The same SvelteKit build served to browser/PWA clients connecting remotely | Connections management only |

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

**Future extension point (not 0.13.0):** `pwa-static` + remote connection with `grantedCapabilities` → add `assistant-settings:read/write` for that connection.

---

## 5. Current architecture problems

**A — one `admin` boolean cannot express the matrix.** `FeatureFlags { admin: boolean }` cannot represent PWA connection management without host, or assistant-container persona editing without host stack access.

**B — connection management locked to `/admin`.** PWA and remote scenarios need connection management without host admin.

**C — `/proxy/assistant/*` requires host admin auth.** Wrong for assistant-container and PWA.

**D — landing logic is host-centric.** Root always redirects to `/splash` which computes local stack state. Wrong for assistant-container and PWA.

**E — host/origin checks hard-coded to loopback.** Incompatible with assistant-container URL or PWA.

**F — assistant settings mix host and assistant concerns.** Persona (assistant-scoped) and `OP_PROJECT_NAME` / bind address (host-scoped) are in the same tab.

**G — skeleton delivery is fragile.** Five-step fallback ladder in `ui-assets.ts` ending in a GitHub raw URL tied to an exact git tag. Does not resolve `latest`. Breaks in air-gapped environments. `import.meta.url`-relative paths break when lib is bundled. This is the only remaining component not following the standard artifact delivery pattern.

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

| Namespace | Purpose | Auth |
|---|---|---|
| `/api/runtime` | Server runtime context | Public — no auth |
| `/api/connections/*` | Connection list, active connection, validation | `connections:manage` capability |
| `/api/assistant/*` | Assistant-owned settings | `assistant-settings:write` capability |
| `/api/host/*` | Host stack lifecycle, privileged ops | `host:stack:write` + loopback-only |
| `/proxy/assistant/*` | Same-origin assistant broker | Same-origin cookie |

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

### 6.7 `@openpalm/skeleton` package

```
packages/skeleton/
  package.json          # name: "@openpalm/skeleton", no main, no exports, no build, no deps
  manifest.json         # [{relPath, category: 'managed'|'guardian-managed'|'seeded'}]
  tools.json            # global CLI tool defaults; per-tool env key + default version range
  config/
    stack/              # core.compose.yml, services.compose.yml, portals.compose.yml, custom.compose.yml
    assistant/          # opencode.jsonc (seeded), persona.md (seeded), instructions/, themes/
    guardian/           # opencode.jsonc (guardian-managed), instructions/moderation.md (guardian-managed)
  knowledge/
    skills/             # bundled skills
    tasks/              # automation task YAML files
```

**`tools.json` schema:**

```json
{
  "global": [
    { "package": "opencode",                  "envKey": "OP_TOOL_OPENCODE_VERSION",    "default": "^1.2.3" },
    { "package": "@anthropic-ai/claude-code", "envKey": "OP_TOOL_CLAUDE_CODE_VERSION", "default": "^1.5.0" },
    { "package": "@openai/codex",             "envKey": "OP_TOOL_CODEX_VERSION",       "default": "^0.1.0" }
  ]
}
```

The `envKey` field is explicit — no magic normalization of `@scope/package-name`. Adding a new tool is one line + a skeleton publish. Removing a tool is one line + a skeleton publish. No image rebuild. The default range (`^minor`) keeps tools on the latest patch/minor automatically; operators pin exact versions via env vars when needed.

`.openpalm/` in the repo root becomes a README-only stub: "skeleton assets moved to `packages/skeleton/`."

**`manifest.json` schema:**
```json
[
  { "relPath": "config/stack/core.compose.yml", "category": "managed" },
  { "relPath": "config/guardian/instructions/moderation.md", "category": "guardian-managed" },
  { "relPath": "config/assistant/opencode.jsonc", "category": "seeded" }
]
```

`core-assets.ts` reads from `manifest.json` instead of hard-coded `MANAGED_ASSETS`, `GUARDIAN_MANAGED_ASSETS`, `SEEDED_ASSETS` arrays. Write policy logic (`SHIPPED_DEFAULT_HASHES`, `isUnmodifiedDefault`) preserved byte-for-byte.

**Source resolution (replaces 5-step ladder in `ui-assets.ts`):**
```
1. OPENPALM_REPO_ROOT env var → ${root}/packages/skeleton/ (dev mode)
2. require.resolve('@openpalm/skeleton/package.json') → package dir (CLI bundled dep, Electron)
3. npm install --prefix <tmpdir> @openpalm/skeleton@<platformVersion> → upgrade / cold start
```

GitHub raw fallback deleted. Electron `extraResources` skeleton bundle removed (Electron resolves via step 2).

### 6.8 Authentication model

| Surface | Auth |
|---|---|
| Host Control Plane | Existing `op_session` cookie, `HttpOnly`, `SameSite=Strict`, loopback-only. Unchanged. |
| Assistant Control Plane | Guardian Basic auth (matching OpenCode's auth model) |
| Connection Control Plane | Host admin session for writes; capability-gated reads |
| PWA / remote clients | Guardian Basic auth aligned with #435 Bearer seam |

### 6.9 `assistant-container` mode

One image, two co-processes. UI and skeleton pulled from npm at startup:

```sh
# entrypoint.sh — version resolution
resolve_version() {
  local override="$1" platform="$2" name="$3"
  if [ -n "$override" ]; then echo "$override"; return; fi
  if [ -n "$platform" ]; then echo "$platform"; return; fi
  echo "ERROR: Cannot resolve version for $name. Set OP_${name}_VERSION." >&2; exit 1
}

# ── Exact-pinned artifacts ────────────────────────────────────────────────────
UI_VERSION=$(resolve_version "$OP_UI_VERSION" "$PLATFORM_VERSION" "UI")
SKELETON_VERSION=$(resolve_version "$OP_SKELETON_VERSION" "$PLATFORM_VERSION" "SKELETON")

npm install --prefer-offline --omit=dev --prefix /opt/openpalm/ui       "@openpalm/ui@${UI_VERSION}"
npm install --prefer-offline --omit=dev --prefix /opt/openpalm/skeleton  "@openpalm/skeleton@${SKELETON_VERSION}"

# Seed OP_HOME from skeleton (migrations + backups applied by lib)
node -e "require('@openpalm/lib').seedFromSkeleton('/opt/openpalm/skeleton', process.env.OP_HOME)"

# ── Range-versioned CLI tools (from tools.json) ───────────────────────────────
export BUN_INSTALL=/opt/openpalm/tools
export PATH="$BUN_INSTALL/bin:$PATH"

TOOL_PKGS=$(bun -e "
  const tools = require('/opt/openpalm/skeleton/node_modules/@openpalm/skeleton/tools.json').global;
  const pkgs = tools.map(t => t.package + '@' + (process.env[t.envKey] || t.default));
  console.log(pkgs.join(' '));
")
bun add -g $TOOL_PKGS || echo "WARN: some tool installs failed; continuing"

# ── Start UI co-process ───────────────────────────────────────────────────────
OP_UI_HOST_MODE=assistant-container \
OP_UI_SINGLE_CONNECTION=1 \
OP_UI_DEFAULT_ASSISTANT_URL=http://127.0.0.1:4096 \
node /opt/openpalm/ui/node_modules/@openpalm/ui/build/index.js &

exec opencode ...
```

**Mounts in assistant-container mode:**
- `config/assistant/` — read/write
- `config/akm/` — read/write
- No Docker socket
- No broad `OP_HOME` access

### 6.10 PWA mode

Same adapter-node build. `static/manifest.webmanifest` + `src/service-worker.ts`. When resolved capabilities exclude `host:*`, host tabs/nav absent via `hasCapability()`. No new pages. No duplicate UI. IndexedDB connection store for offline-capable connection records.

---

## 7. Implementation phases

All phases ship in **0.13.0**. The prior 0.13.0/0.14.0 split was a staged-rollout hedge for large user bases. With fewer than 10 installs, mostly owner-operated, the constraint doesn't apply. The phases below are implementation ordering (code dependencies), not release milestones.

### Phase 0 — Baseline + skeleton package

Two tracks merged into one phase. Both are non-behavior-changing foundation work.

**Track A: Baseline tests (partially complete)**
- Already done: unit tests for `computeFeatureFlags()` and `hooks.server.ts` route decisions
- Still needed: Playwright smoke tests (host mode, admin redirect, chat route), `docs/technical/ui-route-map.md`

**Track B: `@openpalm/skeleton` package**
1. Create `packages/skeleton/package.json` — no main, no exports, no build, no deps. `files` field restricts to `config/`, `knowledge/`, `manifest.json`.
2. Move `.openpalm/` contents into `packages/skeleton/`. Leave `.openpalm/README.md` stub.
3. Write `packages/skeleton/manifest.json` listing all files with their category.
4. Update `core-assets.ts`: read `MANAGED_ASSETS`, `GUARDIAN_MANAGED_ASSETS`, `SEEDED_ASSETS` from `manifest.json` instead of hard-coded arrays. `bundledAssetPath()` → `require.resolve('@openpalm/skeleton/package.json')`. `SHIPPED_DEFAULT_HASHES` preserved exactly.
5. Update `ui-assets.ts`: three-step resolution chain (§6.7). Delete GitHub raw fallback. Delete Electron extraResources skeleton path.
6. Add `@openpalm/skeleton` as pinned exact-version dep in `packages/cli/package.json`.
7. Remove Electron extraResources skeleton bundle from `packages/electron/electron-builder.yml` / `forge.config.ts`. Electron now resolves via step 2 (bundled npm dep).
8. Add `@openpalm/skeleton` as first entry in `platform-release.yml` publish DAG (must publish before `@openpalm/lib` since lib will import/resolve it).
9. Update dev-setup.sh / `OPENPALM_REPO_ROOT` override to point to `packages/skeleton/` instead of `.openpalm/`.

Acceptance: skeleton resolves from npm dep in all non-dev paths; dev still works via `OPENPALM_REPO_ROOT`; `SHIPPED_DEFAULT_HASHES` hashes still match the same file content; existing installs upgrade correctly; GitHub raw fallback is gone.

### Phase 1 — RuntimeContext v2, no UI change

**Files:** `lib/server/features.ts`, `lib/types.ts`, `routes/+layout.server.ts`, `lib/runtime-context.svelte.ts`, `lib/client-context.ts`, `routes/api/runtime/+server.ts`

1. Replace `FeatureFlags` with `ServerRuntimeContext`. Keep `features.admin` derived alias until migration completes.
2. Add `computeServerRuntimeContext(event)`, `resolveCapabilities(serverCaps, clientCtx)`, `hasCapability(cap)`.
3. Return `serverRuntimeContext` from `+layout.server.ts`.
4. Initialize `clientContext` in `+layout.svelte` (client-only; detect display mode; wire active connection).
5. Derive `effectiveCapabilities` reactively.
6. Add `/api/runtime` endpoint (public, no auth).

Acceptance: existing routes unchanged; `features.admin` alias works; capability matrix correct for all current combinations.

### Phase 2 — Connection management out of `/admin`

**Closes #486.**

1. Rename internal model "endpoint" → "connection" in UI layer. `endpoints.json` unchanged.
2. Add `kind` to `ConnectionEntry`; default existing records.
3. New routes: `/connections`, `/api/connections/*`. Guard with `connections:manage`.
4. Update chat page link: `/admin/endpoints` → `/connections`.
5. `/admin/endpoints` → redirect to `/connections` (0.13.0 alias).

Acceptance: PWA-mode clients can manage connections without `/admin`; host mode unchanged; no data migration.

### Phase 3 — Capability-driven landing and navigation

1. Add `resolveLanding(ctx, launchState)`.
2. Split `/splash` into `/attention`, `/setup`, `/host`, `/chat`, `/connections`.
3. Nav reads `runtimeContext.routes` + `hasCapability()`. No `if (features.admin)` checks.

Acceptance: Electron healthy → chat; assistant-container → chat; PWA no-connections → `/connections/new`.

### Phase 4 — Split Host and Assistant Control Planes

1. Move `/admin` → `/host`. No alias — remove immediately. With <10 installs there's no upgrade audience to protect.
2. Split Assistant tab: host stack settings (`host:stack:write`) vs. assistant settings (`assistant-settings:write`).
3. Split AKM: host-level → host-only; assistant-level → assistant-scoped.
4. `requireCapability()` guard on every `/api/host/*` endpoint.

Acceptance: assistant-container can edit persona/AKM but not project name or bind address; host mode unchanged; `/admin/*` returns 404.

### Phase 5 — `assistant-container` mode

*Depends on Phases 0, 1, 4.*

1. Add UI + skeleton install to `containers/assistant/entrypoint.sh` (see §6.9).
2. `npm install --prefer-offline` for both packages; fail fast if version unresolvable.
3. `seedFromSkeleton()` call to seed assistant-scoped `OP_HOME` paths.
4. Start SvelteKit UI co-process.
5. Add `PLATFORM_VERSION` build arg to Dockerfile; wire `OP_SKELETON_VERSION` and `OP_UI_VERSION` defaults.
6. Add locked default connection to local OpenCode (port 4096).
7. Add named Docker volume `openpalm-artifact-cache` mounted at `/opt/openpalm` (covers UI, skeleton, and tools cache in one volume).
8. Add `tools.json` to `@openpalm/skeleton` with initial tool list and `^minor` defaults.
9. Wire `BUN_INSTALL=/opt/openpalm/tools` in entrypoint before tool install step.

Acceptance: `docker restart` with new `OP_UI_VERSION` or `OP_SKELETON_VERSION` picks up new artifact; `OP_TOOL_CLAUDE_CODE_VERSION=^2.0.0` overrides that tool's range; tool install failure logs a warning and does not block container start; tools available on PATH; `/api/host/*` returns 403; assistant settings editable; skeleton correctly seeds assistant config on first start.

### Phase 6 — PWA mode

*Depends on Phases 1, 2, 3.*

1. `static/manifest.webmanifest` + `src/service-worker.ts`.
2. When resolved capabilities exclude `host:*`, host routes absent — no new pages.
3. IndexedDB connection store for offline operation.
4. Remote auth: Guardian Basic auth aligned with #435.

### Phase 7 — Security hardening

*Depends on Phases 1–6.*

1. Host admin loopback-only checks unchanged.
2. Context-aware origin checks per mode.
3. Route guard tests for every `/api/host/*` endpoint (must 403 in non-host modes).
4. Negative tests: assistant-container and PWA cannot reach host APIs.
5. CSP review.

### Phase 8 — Release integration

*Depends on all prior phases.*

1. Add `OP_UI_VERSION`, `OP_SKELETON_VERSION` to compose env-file docs and release notes.
2. New docs: `docs/technical/ui-runtime-modes.md` (replaces this plan), `docs/technical/artifact-delivery-pattern.md`.
3. Release checklist: smoke-test electron-host, assistant-container (with version overrides), pwa-static before publishing.

---

## 8. Non-negotiable rules

1. **`latest` is never a production fallback.** Every component resolves to an explicit version or fails loudly.
2. **`isUnmodifiedDefault` and `SHIPPED_DEFAULT_HASHES` are preserved byte-for-byte.** Skeleton version must equal platform version in production or these hashes diverge and the guardian-managed write policy silently misfires.
3. **Host admin remains loopback-only.** Never weakened.
4. **Assistant container gets no Docker socket and no broad OP_HOME write access.**
5. **APIs enforce capabilities server-side.** `hasCapability()` is UX, not the security boundary.
6. **`resolveCapabilities()` is the only place capability logic lives.** No scattered `if (features.admin)`.
7. **`OPENPALM_REPO_ROOT` dev override is preserved forever.** Essential for local dev loop.
8. **Backup-before-overwrite for managed assets is preserved.** User recovery path for bad skeleton releases.
9. **`grantedCapabilities` on connections must be server-verified at connection-add time.** The client cannot self-grant capabilities.

---

## 9. File-level change map

| Area | Current | Change |
|---|---|---|
| Skeleton source | `.openpalm/` (repo root) | Move to `packages/skeleton/`; leave README stub |
| Skeleton path resolution | `ui-assets.ts` 5-step ladder + GitHub raw | Three-step chain; delete GitHub raw; delete Electron extraResources path |
| Skeleton asset arrays | Hard-coded in `core-assets.ts` | Read from `packages/skeleton/manifest.json` |
| Skeleton bundled path | `import.meta.url` relative | `require.resolve('@openpalm/skeleton/package.json')` |
| CLI deps | (skeleton not listed) | Add `@openpalm/skeleton` pinned exact dep |
| Electron extraResources | Bundles skeleton dir | Remove; Electron resolves via npm dep |
| Feature flags | `lib/server/features.ts`, `lib/types.ts` | Replace with `ServerRuntimeContext` + `resolveCapabilities()` |
| Client context | (none) | New `lib/client-context.ts` |
| Layout data | `routes/+layout.server.ts`, `+layout.svelte` | Pass server context; initialize client context + resolved caps |
| Landing | `routes/+page.ts`, `routes/splash/*`, `hooks.server.ts` | `resolveLanding()` |
| Host admin | `routes/admin/*` | Move/alias to `/host`; `host:*` guards |
| Connections | `routes/admin/endpoints/*`, `endpoints-state.svelte.ts` | Move to `/connections`; rename internal model |
| Assistant settings | `AssistantTab.svelte` | Split host stack vs. assistant-owned |
| AKM | `AkmTab.svelte` | Split assistant-scoped vs. host-only |
| Assistant image | `containers/assistant/entrypoint.sh`, `Dockerfile` | Runtime npm pull for UI + skeleton; co-process start |
| Electron main | `packages/electron/src/main.ts` | Pass `OP_UI_HOST_MODE=electron-host` |
| Release DAG | `platform-release.yml` | `@openpalm/skeleton` first in publish order |

---

## 10. Milestone summary

**0.13.0 — All phases**

Implementation order (phases are code-dependency ordering, not release gates):

```
Phase 0 (skeleton package) ──────────────────────────────► prerequisite for all
Phase 1 (RuntimeContext)   ──────────────────────────────► prerequisite for 2–8
Phase 2 (connections)      ──┐
Phase 3 (landing)          ──┼─► parallelizable ──────────► prerequisite for 5–8
Phase 4 (control plane split) ┘
Phase 5 (assistant-container) ─ needs 0, 1, 4 ──────────► prerequisite for 7–8
Phase 6 (PWA)              ─── needs 1, 2, 3 ────────────► prerequisite for 7–8
Phase 7 (security tests)   ─── needs 1–6 ───────────────► prerequisite for 8
Phase 8 (release cleanup)  ─── needs all ───────────────► ships in 0.13.0
```

No 0.14.0 split. The split was a staged-rollout hedge for large installs; it does not apply here.

---

## 11. Acceptance criteria

**Skeleton delivery:**
- `@openpalm/skeleton` resolves from bundled npm dep in CLI and Electron (no network call needed for CLI path)
- `OPENPALM_REPO_ROOT` still works for local dev
- GitHub raw fallback is gone; Electron extraResources skeleton is gone
- `SHIPPED_DEFAULT_HASHES` values are unchanged; `isUnmodifiedDefault` still works correctly
- `manifest.json` drives asset category logic in `core-assets.ts`
- `@openpalm/skeleton` publishes before `@openpalm/lib` in the release DAG

**Capability system:**
- `resolveCapabilities()` is the only capability logic; all components call `hasCapability()` only
- Adding a new capability rule requires editing one function
- Electron gets all caps; assistant-container gets chat + assistant-settings; pwa-static gets connections + chat

**Host modes:**
- Electron app: full host management, all features
- Browser to host UI: full host management when authenticated
- Browser to assistant-container URL: chat + assistant settings only; `/api/host/*` returns 403
- PWA: install prompt works; add/switch remote connections; no host controls visible or callable

**Versioning:**
- `OP_UI_VERSION` and `OP_SKELETON_VERSION` override the version used by the assistant container
- Neither ever silently falls back to `latest`
- `docker restart` with a new version env var picks up the new artifact

**Release:**
- All three host modes smoke-tested before publishing each release
