# Implementation Plan Index: Host Admin Migration

> **Proposal source:** `docs/technical/proposals/host-admin-migration.md`
> **Generated:** 2026-05-16
> **Status:** Ready for implementation

---

## Overview

Four phase plan to move the OpenPalm admin from a Docker container to a host-side Bun process, make the browser UI the primary user surface, and eliminate the admin container, docker-socket-proxy, and admin-tools package.

| Phase | File | Steps | Estimated effort | Gate |
|---|---|---|---|---|
| **1a** — Server proof-of-concept | [phase-1a.md](phase-1a.md) | 18 steps | 1 sprint | None — starts now |
| **1b** — Chat UI (new feature) | [phase-1b.md](phase-1b.md) | 17 steps | 1 sprint | Phase 1a complete; Spike 2 confirmed |
| **2** — Route migration + cutover | [phase-2.md](phase-2.md) | ~30 steps (6 workstreams) | 1 sprint | Phase 1a soaked for ≥ 1 release |
| **3** — Deletion + security docs | [phase-3-and-security.md](phase-3-and-security.md) | 13 steps + 5 security | Phase 3: 0.5 sprint | Phase 2 soaked for ≥ 1 release |

**Security hardening steps** (5 steps in `phase-3-and-security.md` Part 1) must be **implemented in Phase 1a** and tested in Phase 2, even though they live in that file.

---

## Phase 1a — Server Proof-of-Concept

**Goal:** Prove the host admin server works. Admin container still exists. Both paths run via `OPENPALM_ADMIN_MODE=host|container` (default: `container`).

**Key deliverables:** `openpalm admin` CLI command, tarball extraction strategy, host OpenCode subprocess with SIGTERM wiring, cookie auth + Host/Origin guards, proxy routes.

| Step | Title | Key files |
|---|---|---|
| 1 | Add `admin:build:tar` to `packages/admin/package.json` | `packages/admin/package.json` |
| 2 | Add root `admin:build:tar` shortcut | `package.json` (root) |
| 3 | Embed admin tarball in CLI binary | `packages/cli/src/lib/embedded-assets.ts` |
| 4 | Create `admin-build.ts` — tarball extraction utility | `packages/cli/src/lib/admin-build.ts` (new) |
| 5 | Create `host-admin-server.ts` — Bun.serve gateway | `packages/cli/src/lib/host-admin-server.ts` (new) |
| 6 | Add `OPENPALM_ADMIN_MODE` type to lib | `packages/lib/src/control-plane/types.ts` |
| 7 | Re-export `resolveAdminMode` from lib barrel | `packages/lib/src/index.ts` |
| 8 | Add `admin serve` subcommand | `packages/cli/src/commands/admin.ts` (new) |
| 9 | Wire `OPENPALM_ADMIN_MODE` into install | `packages/cli/src/commands/install.ts` |
| 10 | Add `admin:build:tar` to CLI build pipeline | `packages/cli/package.json` |
| 11 | Update `auth.ts` to also set cookie | `packages/admin/src/lib/auth.ts` |
| 12 | Add `/admin/auth/session` cookie-issuance route | `packages/admin/src/routes/admin/auth/session/+server.ts` (new) |
| 13 | Unit tests for `ensureAdminBuild` | `packages/cli/src/lib/admin-build.test.ts` (new) |
| 14 | Unit tests for auth middleware | `packages/cli/src/lib/host-admin-server.test.ts` (new) |
| 15 | Smoke test `openpalm admin serve --help` | `packages/cli/src/main.test.ts` (line ~47) |
| 16 | Explicit `out: "build"` in svelte.config.js | `packages/admin/svelte.config.js` |
| 17 | Confirm test discovery for new test files | `packages/cli/bunfig.toml` or `package.json` |
| 18 | Document `OPENPALM_ADMIN_MODE` in core-principles | `docs/technical/core-principles.md` |

**Also implement in Phase 1a** (from `phase-3-and-security.md` Part 1):
- **SEC-1:** Host header allowlist in `helpers.ts` + `hooks.server.ts`
- **SEC-2:** Origin check wired into `withAdminBody` (helpers.ts line 269)
- **SEC-3:** Admin skills allowlist (`packages/cli/src/lib/admin-skills/index.ts`)
- **SEC-4:** Token file management (`packages/lib/src/control-plane/admin-token.ts`)
- **SEC-5:** Windows `symlinkSync` → `copyFileSync` (`opencode-subprocess.ts` line 60)

---

## Phase 1b — Chat UI

**Goal:** The primary user surface. Chat with Assistant/Admin toggle, visual thread segmentation, voice I/O integration. **Do not start until Phase 1a is deployed and Spike 2 (OpenCode protocol) is confirmed.**

> **Spike 2 result (already confirmed):** OpenCode uses plain HTTP POST returning full JSON — no SSE, no WebSocket. `Bun.serve` fetch passthrough works. 150s timeout required.

| Step | Title | Key files |
|---|---|---|
| 1 | Add chat types to `$lib/types.ts` | `packages/admin/src/lib/types.ts` |
| 2 | Add `createChatSession`, `sendChatMessage` to `$lib/api.ts` | `packages/admin/src/lib/api.ts` |
| 3 | Create assistant proxy route | `packages/admin/src/routes/proxy/assistant/[...path]/+server.ts` (new) |
| 4 | Create admin proxy route | `packages/admin/src/routes/proxy/admin/[...path]/+server.ts` (new) |
| 5 | Move admin dashboard to `/admin` route | `packages/admin/src/routes/admin/+page.svelte` (restructure) |
| 6 | Create `ChatMessage.svelte` display component | `packages/admin/src/lib/components/ChatMessage.svelte` (new) |
| 7 | Create `ChatInput.svelte` component | `packages/admin/src/lib/components/ChatInput.svelte` (new) |
| 8 | Create `/chat/+page.svelte` — main chat page | `packages/admin/src/routes/chat/+page.svelte` (new) |
| 9 | Update `Navbar.svelte` — add Admin nav link | `packages/admin/src/lib/components/Navbar.svelte` |
| 10 | Add Chat link to admin Navbar | Same as step 9 |
| 11 | Wire 150s timeout in `sendChatMessage` | `packages/admin/src/lib/api.ts` |
| 12 | Add root `+page.ts` redirect → `/chat` | `packages/admin/src/routes/+page.ts` (new) |
| 13 | Add `OP_ADMIN_OPENCODE_INTERNAL_URL` to dev compose | `compose.dev.yml` |
| 14 | Wire `VoiceControl` into chat layout | `packages/admin/src/routes/chat/+layout.svelte` (new) |
| 15 | Update Playwright tests navigating to `/` | `packages/admin/e2e/` |
| 16 | Type-check and build verification | `bun run admin:check && bun run admin:build` |
| 17 | Manual smoke test checklist | — |

---

## Phase 2 — Route Migration + Cutover

**GATE: Requires Phase 1a/1b to soak for at least 1 release. Do not begin Phase 2 automatically.**

**Goal:** Migrate all 52 API routes to Bun.serve handlers, flip `OPENPALM_ADMIN_MODE=host` as default, complete cookie auth, consolidate docker in lib, handle automation migration.

Six parallel workstreams:

### Workstream A — Push `appendAudit` into lib

| Step | Title | Key files |
|---|---|---|
| A-1 | Add `AuditContext` type to lib types | `packages/lib/src/control-plane/types.ts` |
| A-2 | Add optional `ctx` param to lib mutating functions | `packages/lib/src/control-plane/lifecycle.ts`, `config-persistence.ts`, `secrets.ts` |
| A-3 | Remove direct `appendAudit` calls from routes that now get it from lib | All 45 routes calling `appendAudit` |

### Workstream B — Auth migration (x-admin-token → cookie)

| Step | Title | Key files |
|---|---|---|
| B-1 | Add `/admin/auth/login` and `/admin/auth/logout` routes | `packages/admin/src/routes/admin/auth/` |
| B-2 | Update `requireAdmin` / `requireAuth` to accept cookie OR header | `packages/admin/src/lib/server/helpers.ts` (lines 67–116) |
| B-3 | Delete `packages/admin/src/lib/auth.ts` | `packages/admin/src/lib/auth.ts` |
| B-4 | Remove `token` param from all `api.ts` functions | `packages/admin/src/lib/api.ts` (~25 functions) |
| B-5 | Remove token threading from `+page.svelte` | `packages/admin/src/routes/+page.svelte` |
| B-6 | Update 45 vitest test files — replace header with cookie | `packages/admin/src/lib/server/*.vitest.ts` (17 files) |

### Workstream C — Migrate 52 routes to Bun.serve

| Step | Title | Key files |
|---|---|---|
| C-1 | Create `packages/admin/src/server/router.ts` | New file |
| C-2 | Create `packages/admin/src/server/entry.ts` — Bun.serve entrypoint | New file |
| C-3 | Define migration template (before/after for each route type) | — |
| C-4 | Migrate all 52 routes (mechanical, parallelizable) | All `packages/admin/src/routes/admin/**/+server.ts` |
| C-5 | Update `packages/admin/package.json` start script | `packages/admin/package.json` |

### Workstream D — Default mode cutover

| Step | Title | Key files |
|---|---|---|
| D-1 | `resolveAdminMode()` defaults to `host` | `packages/lib/src/control-plane/types.ts` |
| D-2 | CLI install skips admin container when mode is `host` | `packages/cli/src/commands/install.ts` |
| D-3 | Remove container-mode startup assumptions from `state.ts` | `packages/admin/src/lib/server/state.ts` |

### Workstream E — Docker lib consolidation (R6)

| Step | Title | Key files |
|---|---|---|
| E-1 | Move preflight enforcement into lib docker module | `packages/lib/src/control-plane/docker.ts` |
| E-2 | Move `inspectContainerStatus` into lib | `packages/lib/src/control-plane/docker.ts` |
| E-3 | Delete `packages/admin/src/lib/server/docker.ts` | `packages/admin/src/lib/server/docker.ts` |
| E-4 | Export `inspectContainerStatus` from lib barrel | `packages/lib/src/index.ts` |

### Workstream F — Scheduler automation migration (R7)

| Step | Title | Key files |
|---|---|---|
| F-1 | Add `openpalm automations check` command | `packages/cli/src/commands/automations.ts` (new) |
| F-2 | Register in CLI routing | `packages/cli/src/main.ts` |
| F-3 | Detect stale cron actions in automations catalog route | `packages/admin/src/routes/admin/automations/catalog/+server.ts` |

---

## Phase 3 — Deletion + Security Docs

**Gate:** Phase 2 has shipped in a production release. Run the final validation suite before marking complete.

### Tier 1 — Independent (parallel)

| Step | Title | Key files |
|---|---|---|
| 1 | Delete `core/admin/` | `core/admin/` (4 files) |
| 2 | Delete admin addon registry entry + fix validate-registry.sh | `.openpalm/registry/addons/admin/`, `scripts/validate-registry.sh:102` |
| 3 | Delete `packages/admin-tools/` + remove from package.json | `packages/admin-tools/`, `package.json` (root) |
| 6 | Remove `OP_ADMIN_API_URL` from core.compose.yml | `.openpalm/stack/core.compose.yml:77`, `core/assistant/README.md:55` |
| 13 | Update test scripts | `scripts/dev-e2e-test.sh:316`, `scripts/release-e2e-test.sh:483`, `scripts/upgrade-test.sh` |

### Tier 2 — After Tier 1

| Step | Title | Key files |
|---|---|---|
| 4 | Remove `selfRecreateAdmin` | `packages/lib/.../docker.ts:318–339`, `index.ts:210`, admin docker wrapper, upgrade route |
| 5 | Simplify `OptionalServiceName` / `OPTIONAL_SERVICES` | `packages/lib/src/control-plane/types.ts:11,68–71` |
| 7 | Remove `OPENPALM_ADMIN_MODE` feature flag | Wherever Phase 1a added it |
| 8 | Clean SSRF blocklist in helpers.ts | `packages/admin/src/lib/server/helpers.ts:139–144` |
| 9 | Delete `docker-dependency-resolution.md` | `docs/technical/docker-dependency-resolution.md`, `CLAUDE.md`, `core-principles.md:229` |

### Tier 3 — After Tier 2 (docs, same commit)

| Step | Title | Key files |
|---|---|---|
| 10 | Update `core-principles.md` — new invariants | `docs/technical/core-principles.md:58,228–249` |
| 11 | Update `foundations.md` — UI-first + admin host section | `docs/technical/foundations.md:45,59,242–298` |
| 12 | Update remaining docs | `environment-and-mounts.md`, `opencode-configuration.md`, `AGENTS.md`, `CLAUDE.md`, etc. |

### Final Validation Suite

Run `phase-3-and-security.md` "Final Validation Suite" bash script. All 10 grep checks must return zero results.

---

## AKM assets that can assist

| Phase | Step area | Asset / query |
|---|---|---|
| 1a | Bun.serve proxy patterns | `akm search "bun serve proxy streaming"` |
| 1a | Subprocess signal handling | `akm search "subprocess sigterm cleanup"` |
| 1a | Binary tarball embedding | `akm search "bun compile embed assets"` |
| 1b | Svelte 5 streaming UI patterns | `akm search "svelte 5 streaming sse chat"` |
| 1b | OpenCode client API | `akm show knowledge:opencode-api` (if indexed) |
| 2 | Route migration automation | `akm search "sveltekit route migration bun"` |
| All | Security: CSRF + DNS rebinding | `akm search "localhost csrf dns rebinding"` |
| All | Code review | `/code-review-basic` or `/security-analyzer` skills |

---

## Completion checklist

- [ ] Phase 1a: `openpalm admin serve` starts, browser opens, both container and host admin modes work
- [ ] Phase 1a: SEC-1 through SEC-5 security hardening in place
- [ ] Phase 1a: `bun run cli:test` passes, `bun run admin:check` passes
- [x] Phase 1b: Chat UI opens by default, toggle switches backends, thread segmentation visible — **COMPLETE 2026-05-16**
- [x] Phase 1b: `bun run admin:test:unit` passes (459/459), `bun run admin:check` passes (0 errors) — **COMPLETE 2026-05-16**
- [ ] Phase 2: All 52 routes migrated, `OPENPALM_ADMIN_MODE=host` is default
- [ ] Phase 2: `x-admin-token` no longer needed (cookie-only)
- [ ] Phase 2: `bun run check` passes (admin + sdk)
- [ ] Phase 3: Final validation suite returns all green
- [ ] Phase 3: `bun run test` passes (all non-admin tests)
- [ ] Phase 3: `bun run admin:test` passes (vitest + playwright)
