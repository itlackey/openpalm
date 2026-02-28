# OpenPalm MVP — Full Backlog Implementation Plan

## Context

The todos.md backlog covers 8 distinct work items. Per user direction, **Svelte 5 upgrade and runes migration come first** before any new code is added to the admin project. Steps 1 and 2 include an iterative multi-agent peer review, web-based fact checking, and verification loop — we do not proceed to step 3 until the admin is confirmed regression-free on Svelte 5.

---

## Execution Order

```
1. Verify + update packages (npm version check → sv migrate for deps)
2. Migrate to runes syntax   (sv migrate svelte-5 → iterative peer review loop)
   ── GATE: npm run check passes, manual smoke test passes ──
3. core/ directory move
4. Root convenience scripts
5. Shared logger
6. Migrate console.log calls
7. containers/pull endpoint
8. Component refactor (Svelte 5 style)
9. Connections API
10. Connections screen UI (Svelte 5)
11. Post-login check
```

---

## Step 1: Verify Latest Package Versions + Upgrade to Svelte 5

### 1a. Verify current vs. latest versions on npm

Before touching any files, query npm for the latest stable version of each admin dependency:
```bash
npm view @sveltejs/kit version
npm view svelte version
npm view @sveltejs/vite-plugin-svelte version
npm view @sveltejs/adapter-node version
npm view @sveltejs/adapter-auto version
npm view svelte-check version
npm view typescript version
npm view vite version
npm view vitest version
npm view @types/node dist-tags.latest
```

Record actual latest versions. This prevents pinning to outdated semver ranges.

### 1b. Use `sv` CLI to upgrade packages

Svelte's official CLI handles version coordination between `svelte`, `@sveltejs/kit`, `@sveltejs/vite-plugin-svelte`, and `svelte-check` to ensure compatible versions:

```bash
cd admin
npx sv migrate  # runs the interactive migration wizard; choose "Svelte 5"
# OR use the direct upgrade path:
npx sv add      # to add/update dependencies as needed
```

The `sv migrate` command updates `package.json` dependencies, updates `svelte.config.js` if needed, and can optionally run the Svelte 5 codemods on `.svelte` files. For step 1, **update deps only** — defer the codemod pass to step 2.

If `sv migrate` doesn't handle all packages, manually update `package.json` to the verified latest versions and run `npm install`.

### 1c. Verification after package update

```bash
cd admin && npm install
npm run check   # svelte-check with Svelte 5 — Svelte 4 compat layer allows existing code to compile
npm run build   # production build must succeed
```

**Gate:** Both `check` and `build` must pass before proceeding. Fix any type errors surfaced by the updated `svelte-check`.

---

## Step 2: Migrate to Svelte 5 Runes — Iterative Peer Review Loop

### 2a. Run sv migrate codemods

```bash
cd admin
npx sv migrate svelte-5
```

This automated codemod converts:
- `let x = value` (reactive) → `let x = $state(value)`
- `$: x = expr` → `let x = $derived(expr)`
- `$: { statement }` → `$effect(() => { statement })`
- `on:click={fn}` → `onclick={fn}`
- `export let prop` → `let { prop } = $props()`
- `<slot>` → `{@render children()}`

**Files targeted:** `admin/src/routes/+page.svelte`, `admin/src/routes/+layout.svelte`

### 2b. Manual review and fixes

The codemod handles ~80–90% of cases. Manual attention required for:
- `on:submit|preventDefault` → `onsubmit={(e) => { e.preventDefault(); fn(e); }}`
- Complex `$:` blocks that depend on each other (ordering may change)
- Any `onDestroy` → `$effect(() => { return () => cleanup(); })`
- Snippet syntax if any `<slot name="x">` patterns exist

### 2c. Iterative peer review loop (repeat until gate passes)

Each iteration:

1. **Run svelte-check:** `cd admin && npm run check` — must produce zero errors
2. **Agent peer review:** Launch a Svelte 5 expert agent to review the migrated code for:
   - Incorrect runes usage (e.g., `$derived` containing side effects, `$state` in wrong scope)
   - Missing reactivity (state that should be `$state` but isn't)
   - Event handler patterns that don't work in Svelte 5
   - Any remaining Svelte 4 syntax not converted by the codemod
3. **Web fact-check:** Fetch Svelte 5 migration guide and runes documentation to verify specific patterns used:
   - https://svelte.dev/docs/svelte/v5-migration-guide
   - https://svelte.dev/docs/svelte/$state
   - https://svelte.dev/docs/svelte/$derived
   - https://svelte.dev/docs/svelte/$effect
4. **Fix issues** surfaced by peer review and fact-checking
5. **Re-run check:** Confirm zero errors
6. **Smoke test:** Start `npm run dev`, manually verify:
   - Admin login flow works
   - All three tabs (Overview, Containers, Artifacts) render correctly
   - Container list loads and actions (up/down/restart) still work
   - No console errors in browser

Repeat until all checks pass with zero issues.

### Runes migration reference (Svelte 4 → Svelte 5)

| Svelte 4 | Svelte 5 Runes |
|----------|---------------|
| `let x = value` (reactive) | `let x = $state(value)` |
| `$: x = expr` | `let x = $derived(expr)` |
| `$: { sideEffect() }` | `$effect(() => { sideEffect() })` |
| `on:click={fn}` | `onclick={fn}` |
| `on:submit\|preventDefault={fn}` | `onsubmit={(e) => { e.preventDefault(); fn(e); }}` |
| `bind:value={x}` | `bind:value={x}` (unchanged) |
| `export let prop` | `let { prop } = $props()` |
| `createEventDispatcher` | callback props in `$props()` |
| `onMount(() => fn)` | `onMount(() => fn)` (unchanged) |
| `onDestroy(() => fn)` | `$effect(() => { return () => fn() })` |
| `<slot>` | `{@render children()}` + `let { children } = $props()` |

---

## ── GATE: Steps 1–2 Complete ──

**Do not proceed to step 3 until:**
- [ ] `cd admin && npm run check` passes with zero errors
- [ ] `npm run build` produces a successful production build
- [ ] Peer review agent has signed off on the runes migration
- [ ] Svelte 5 migration guide fact-check confirms all patterns are correct
- [ ] Manual smoke test: login, all tabs render, container actions work, no browser console errors

---

## Step 3: Move admin, assistant, guardian into ./core/

**Goal:** `admin/ → core/admin/`, `guardian/ → core/guardian/`, `assistant/ → core/assistant/`

### Files to update:

**`/package.json`** — workspaces and scripts:
```json
"workspaces": ["core/admin", "packages/lib", "core/guardian", "channels/chat", "channels/api", "channels/discord"]
```

**`core/admin/vite.config.ts`** — `__dirname` is now 2 levels deep; update all path resolutions:
```typescript
// Before (admin/ = 1 level):
const rootDir = resolve(__dirname, "..");
"$assets": resolve(__dirname, "../assets"),
"$registry": resolve(__dirname, "../registry")

// After (core/admin/ = 2 levels):
const rootDir = resolve(__dirname, "../..");
"$assets": resolve(__dirname, "../../assets"),
"$registry": resolve(__dirname, "../../registry")
```

**`core/admin/Dockerfile`** — update COPY paths (build context stays repo root):
```dockerfile
COPY core/admin/package.json core/admin/bun.lock* ./
COPY core/admin/ .
COPY assets/ ../assets/     # unchanged
COPY registry/ ../registry/ # unchanged
```

**`core/guardian/Dockerfile`** — update COPY path:
```dockerfile
COPY core/guardian/ .
```

**`assets/docker-compose.yml`** — check for any `./admin`, `./guardian`, `./assistant` build context references; update to `./core/*`.

**`scripts/dev-setup.sh`, `scripts/setup.sh`** — search for hardcoded relative paths to admin/guardian/assistant; update.

After move: `npm install` at root → `cd core/admin && npm run check && npm run build`.

---

## Step 4: Add Convenience Scripts to Root package.json

```json
"scripts": {
  "admin:dev":            "bun run --cwd core/admin dev",
  "admin:build":          "bun run --cwd core/admin build",
  "admin:check":          "bun run --cwd core/admin check",
  "guardian:dev":         "bun run core/guardian/src/server.ts",
  "guardian:test":        "bun test --cwd core/guardian",
  "lib:test":             "bun test --cwd packages/lib",
  "channel:chat:dev":     "bun run channels/chat/server.ts",
  "channel:api:dev":      "bun run channels/api/server.ts",
  "channel:discord:dev":  "bun run channels/discord/server.ts",
  "dev:setup":            "./scripts/dev-setup.sh --seed-env",
  "dev:stack":            "docker compose -f .dev/state/artifacts/docker-compose.yml --env-file .dev/config/secrets.env up -d",
  "check":                "bun run admin:check && bun run lib:test"
}
```

---

## Step 5: Shared Logger in packages/lib

**New file:** `packages/lib/src/shared/logger.ts`

```typescript
export type LogLevel = "debug" | "info" | "warn" | "error";

export function createLogger(service: string) {
  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, service, msg, ...(extra ? { extra } : {}) };
    (level === "error" || level === "warn" ? console.error : console.log)(JSON.stringify(entry));
  }
  return {
    info:  (msg: string, extra?: Record<string, unknown>) => log("info",  msg, extra),
    warn:  (msg: string, extra?: Record<string, unknown>) => log("warn",  msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log("error", msg, extra),
    debug: (msg: string, extra?: Record<string, unknown>) => log("debug", msg, extra),
  };
}
```

Add to `packages/lib/package.json` exports: `"./shared/logger.ts": "./src/shared/logger.ts"`

---

## Step 6: Migrate All console.log/console.error Calls

| File | Calls | Action |
|------|-------|--------|
| `core/admin/src/hooks.server.ts` | 3 | `createLogger("admin")` |
| `core/guardian/src/server.ts` | 1 | `createLogger("guardian")` |
| `channels/chat/server.ts` | 1 | `createLogger("channel-chat")` |
| `channels/api/server.ts` | 2 | `createLogger("channel-api")` |
| `channels/discord/server.ts` | 2 | `createLogger("channel-discord")` |

---

## Step 7: New API Endpoint — POST /admin/containers/pull

`composePull()` exists in `docker.ts` but has no route. Add `core/admin/src/routes/admin/containers/pull/+server.ts`. Calls `composePull()` then `composeUp()` to recreate containers with pulled images. Auth-gated, audit-logged.

---

## Step 8: Admin UI Component Refactor (Svelte 5)

Split the migrated `+page.svelte` into focused Svelte 5 components with scoped `<style>` blocks and CSS nesting. No visual regressions.

**New lib files:** `api.ts`, `types.ts`, `auth.ts`

**New components in `core/admin/src/lib/components/`:**
`Navbar`, `AuthGate`, `TabBar`, `ConnectionBanner`, `OverviewTab`, `ContainersTab`, `ContainerRow` (with Start/Stop/Restart buttons), `ArtifactsTab`

Svelte 5 component pattern — callback props instead of `createEventDispatcher`:
```svelte
<script lang="ts">
  let { containers, onStart, onStop, onRestart } = $props();
</script>
```

New stack-level buttons in `OverviewTab`:
- **Apply Changes** → `POST /admin/update`
- **Update All Containers** → `POST /admin/containers/pull`

Layout updated to render `Navbar` on all routes.

---

## Step 9: Connections API

**New function in `control-plane.ts`:** `patchSecretsEnvFile(configDir, patches)` — reads `CONFIG_HOME/secrets.env`, updates specific key=value lines without deleting user content, writes back. User-triggered only.

**New routes:**
- `core/admin/src/routes/admin/connections/+server.ts` — GET (read current values) + POST (patch secrets.env)
- `core/admin/src/routes/admin/connections/status/+server.ts` — GET returns `{ complete: boolean, missing: string[] }`

Allowed keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_API_KEY`, `GUARDIAN_LLM_PROVIDER`, `GUARDIAN_LLM_MODEL`, `OPENMEMORY_OPENAI_BASE_URL`, `OPENMEMORY_OPENAI_API_KEY`

---

## Step 10: Connections Screen UI (Svelte 5)

**New files:**
- `core/admin/src/routes/connections/+page.svelte` — Svelte 5 runes throughout
- `core/admin/src/routes/connections/+page.server.ts`
- `core/admin/src/lib/opencode/client.server.ts` — wraps `@opencode-ai/sdk`

**Three sections:** OpenCode Provider API keys (+ registers with OpenCode REST API), Guardian LLM config, OpenMemory config.

---

## Step 11: Post-Login Connection Check

After auth success, call `GET /admin/connections/status`. If `!complete`, render `ConnectionBanner` with link to `/connections`. Session-only (not persisted).

---

## Critical Files

| File | Why |
|------|-----|
| `admin/src/routes/+page.svelte` | Target of steps 2 and 8 |
| `admin/vite.config.ts` | Path depth change after core/ move (step 3) |
| `admin/Dockerfile` | COPY path updates (step 3) |
| `admin/src/lib/server/control-plane.ts` | Add `patchSecretsEnvFile` (step 9) |
| `admin/src/lib/server/docker.ts` | `composePull()` exists; referenced by step 7 |
| `packages/lib/src/shared/logger.ts` | New file (step 5) |
| `packages/lib/package.json` | Add logger export (step 5) |
| `/package.json` | Workspace paths + convenience scripts (steps 3, 4) |
