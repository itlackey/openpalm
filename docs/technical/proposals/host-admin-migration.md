# Proposal: Move Admin to Host, Make the Browser UI the Primary Surface

> **Status:** Draft — reviewed, spikes pending.
> **Owner:** TBD.
> **Targets:** v0.12.0 (Phase 1a–1b), v0.12.x (Phase 2), v0.13.0 (Phase 3+).
> **Supersedes (when accepted):** parts of `docs/technical/core-principles.md` § Security invariant #1, `docs/technical/docker-dependency-resolution.md` (becomes obsolete).

---

## Executive summary

The admin container is dead weight. Almost everything it does is already host-doable: the CLI already wraps `docker compose`, already runs `Bun.serve` for the setup wizard, already spawns `opencode` as a subprocess, and the shared lib (`@openpalm/lib`) already centralizes control-plane logic.

**Recommendation:** fold admin into the CLI as **one Bun binary** that:

1. Serves a SvelteKit UI on `127.0.0.1` and opens the user's browser.
2. Shells out to Docker directly from the host.
3. Spawns two `opencode` subprocesses on the host — one proxying the **user assistant** container, one with **admin skills** running entirely on the host.
4. Presents the user, on first launch after setup, with a **chat interface** that toggles between the two OpenCode instances. The current admin pages remain reachable behind an "Admin" link for users who want to manually manage the stack.

The CLI remains a first-class power-user feature (scriptable, headless, CI-friendly), but the **primary, advertised workflow becomes:**

```
download → run `openpalm` → browser opens → chat with the stack
```

This is strictly simpler, strictly more secure, and removes ~3 packages worth of glue.

---

## 1. Primary UX (the user's whole world)

```
┌─ openpalm (web UI on http://localhost:3880) ───────────────────────┐
│                                                                     │
│   [ Chat ]   [ Admin ]   [ Logs ]   [ Settings ]          ⚙ ▾      │
│   ──────                                                            │
│                                                                     │
│   ┌─ Talking to: ( ● Assistant   ○ Admin ) ──────────────────────┐ │
│   │                                                                │ │
│   │   You:    summarize today's discord messages                   │ │
│   │   Asst:   3 threads, mostly about ...                          │ │
│   │                                                                │ │
│   │   You:    [ toggle → Admin ] now restart the discord channel   │ │
│   │   Admin:  ran `docker compose restart channel-discord`. ✓      │ │
│   │                                                                │ │
│   └──────────────────────────────────────────────────────────────┘ │
│                                                          [ Send → ] │
└─────────────────────────────────────────────────────────────────────┘
```

**Context boundary on toggle:** switching between Assistant and Admin starts a fresh context window — the toggle is visually segmented in the chat thread so the user understands they are now talking to a different agent. The previous thread remains scrollable above the divider. There is no automatic context forwarding between backends by default.

Two backends, one chat surface:

| Toggle position | Talks to | Tools available | Lives where |
|---|---|---|---|
| **Assistant** | OpenCode at `localhost:3800` (container) | user-facing tools, akm memory, akm skills | Docker container `assistant` |
| **Admin** | OpenCode subprocess on host | admin skills: stack ops, compose, addons, secrets, logs | Host process spawned by `openpalm admin` |

The admin link in the top nav opens the existing admin pages (`/admin/...`) as a fallback for manual stack management. **Not the default landing.**

---

## 2. What this lets us delete

| Before | After |
|---|---|
| `core/admin/Dockerfile`, `core/admin/entrypoint.sh`, `core/admin/opencode/` | ❌ deleted |
| `docker-socket-proxy` sidecar service | ❌ deleted |
| `.openpalm/registry/addons/admin/compose.yml` | ❌ deleted |
| `packages/admin-tools/` (~35 OpenCode tools wrapping admin HTTP) | ❌ deleted |
| `admin_docker_net` network | ❌ deleted |
| `OP_ADMIN_API_URL`, `OP_UI_TOKEN`, `OP_ADMIN_BIND_ADDRESS`, `OP_ADMIN_PORT`, `OP_ADMIN_OPENCODE_*` env plumbing | ❌ removed from container env |
| `x-admin-token` HTTP header auth | ❌ replaced with `httpOnly` cookie |
| `docs/technical/docker-dependency-resolution.md` (exists only because of admin-in-Docker) | ❌ deleted |
| Second OpenCode instance on `:3881` inside admin container | ❌ replaced with host subprocess |
| Full `vault/` mount into the admin container | ❌ admin reads host filesystem directly |
| `OP_HOME` whole-tree mount into admin container | ❌ host process reads native paths |
| GPG agent socket bind-mount hack | ❌ host process talks to GPG natively |

---

## 3. Architecture

```
HOST                                          DOCKER (assistant_net only)
─────────────────────────                     ───────────────────────────
openpalm  (single Bun binary)                 guardian   (HMAC ingress)
  ├── install / start / stop / ...            assistant  (OpenCode + akm)
  ├── admin              ← default subcommand <addons>   (channels, ollama, …)
  │     ├── Bun.serve on 127.0.0.1:3880
  │     ├── SvelteKit UI (static build, served from disk)
  │     ├── API handlers → @openpalm/lib direct calls
  │     ├── /proxy/assistant → http://localhost:3800 (container)
  │     ├── /proxy/admin → host OpenCode subprocess (random port)
  │     │      ↳ loaded with admin skills
  │     │      ↳ SIGTERM on admin server exit
  │     └── opens browser
  └── docker compose ←──────── direct CLI

❌ No admin container
❌ No docker-socket-proxy
❌ No admin-tools plugin (tools become host-side admin skills in @openpalm/lib)
❌ No OP_ADMIN_API_URL anywhere in container env
❌ No x-admin-token wire auth
```

Two boundaries collapse into one: the **host process** is the only thing that touches the Docker socket, the vault, the akm stash, and the user's GPG agent. Containers are pure workloads. Containers physically cannot reach `127.0.0.1` on the host → containers cannot reach admin under any configuration (enforced by the OS loopback boundary, not a YAML allowlist).

Note: the host admin talks to the assistant container via `http://localhost:3800` (the container's host-exposed port), bypassing guardian. This is equivalent to the current model where the admin container communicated directly over `assistant_net`. Admin has always been the trusted orchestrator with a direct path to the assistant.

---

## 4. The CLI's role (for power users)

The CLI is **not** the primary surface, but it stays useful:

| Command | Purpose |
|---|---|
| `openpalm` (no args) | Equivalent to `openpalm admin`: starts UI, opens browser. The default. |
| `openpalm install [--file spec.yml]` | First-run wizard or non-interactive install for CI/Ansible. |
| `openpalm admin [--port N] [--no-open] [--bind addr]` | Explicit admin server invocation. |
| `openpalm start / stop / restart` | Compose lifecycle without the UI. |
| `openpalm status / logs / scan` | Power-user introspection. |
| `openpalm chat [--target=assistant\|admin] [-]` | Headless chat for scripting (pipe in a prompt, get a response on stdout). |

The chat command lets power users script the same conversations the UI exposes — same backend, no special-case API.

---

## 5. Recommendations — concrete, ordered by ROI

### R1. Promote the setup wizard's `Bun.serve` pattern into the admin runtime

The wizard already does what we need: Bun.serve, localhost bind, browser open, lifecycle-bound. Generalize `packages/cli/src/setup-wizard/server.ts` into a shared admin server module so the same server runs in two modes:

- **first-run** (current wizard flow — empty `stack.env`)
- **manage** (chat + admin pages — current admin UI, cookie auth on loopback)

Net: one HTTP server, one HTML/UI tree, one set of endpoints. The wizard stops being a separate codebase (today: `wizard.js` + `wizard.css` + 5 hand-rolled validators).

**Defer wizard UI unification** (merging the hand-rolled wizard HTML into the SvelteKit app) to its own sprint — the existing wizard works fine and is small. The server unification is what matters for Phase 1a.

### R2. Migrate admin to a CLI-embedded server — use `adapter-node` output under Bun

- Add `openpalm admin [--port 3880] [--no-open]` command. Make it the default when invoked with no args.
- Keep **SvelteKit `adapter-node`** (do not switch to `adapter-static`). The existing admin pages have zero `+page.server.ts` files and zero form actions; the SPA is already fully client-rendered. However `adapter-static` does not serve the 52 `+server.ts` API routes at all — they would all need to be rewritten as Bun.serve handlers first. Running `adapter-node` output under Bun is the correct intermediate step.
- Route migration (52 `+server.ts` → Bun.serve handlers) is mechanical but should be a separate, parallelizable workstream after Phase 1a proves the server embeds correctly.
- **Static asset serving strategy:** the SvelteKit `adapter-node` build produces a `build/` directory containing `index.js` and `client/` static assets. Do **not** attempt to text-import hundreds of JS chunks into the binary. Instead: on `openpalm admin` startup, extract the bundled assets to `~/.openpalm/cache/admin/{version}/` (only if not already extracted) and serve from disk. The extraction tarball is embedded in the binary as a single `import adminBundleTarball from "./admin-bundle.tar.gz" with { type: "file" }`.

**Why not Tauri/Electron right now?**
- **Tauri**: nice native shell, adds Rust toolchain + per-OS code-signing + cross-compile pipeline. Useful for *distribution polish*. Defer until v1.0.
- **Electron**: ~150 MB chromium overhead. Net negative.
- **Browser UI**: zero extra deps, zero install friction, works headless over SSH.

### R3. Delete `packages/admin-tools/` — but push audit logging down into lib first

The package (~35 OpenCode tools wrapping admin HTTP) exists because the in-Docker assistant needed admin over HTTP. With admin on host that boundary is gone.

**Before deleting:** push `appendAudit()` calls *inside* `@openpalm/lib` mutating functions. Today every mutating admin `+server.ts` calls `appendAudit()` — that logging will silently disappear when AI-driven mutations call `@openpalm/lib` functions directly from the host OpenCode subprocess. If `appendAudit` is inside the lib functions, the audit trail is preserved regardless of caller.

After that:
- The assistant *cannot* reach admin (LAN boundary) → HTTP admin-tools are moot anyway.
- Admin's host OpenCode loads admin skills directly against `@openpalm/lib` — no HTTP, no token, no plugin package.
- Admin skills must have an explicit **allowlist of permitted operations** with argument validation (no path traversal, no arbitrary shell). Destructive operations (uninstall, secret rotation, stack down) require a confirmation step in the tool definition.

The ~35 tools do not collapse to "≤8 functions" — they are a 1:1 migration from HTTP endpoints to direct lib calls, roughly 35 function-level tools each wrapping a named lib export. There is no implied consolidation.

### R4. Spawn admin's OpenCode as a host subprocess

- `openpalm admin` spawns `opencode serve` as a subprocess using the existing `startOpenCodeSubprocess` mechanism in `packages/cli/src/lib/opencode-subprocess.ts`.
- Lifetime is tied to the admin server lifetime.
- **Signal handling is mandatory** for the long-running server: wire `process.on("SIGINT")` and `process.on("SIGTERM")` to call `subprocess.stop()` before `process.exit()`. Without this, `Ctrl-C` orphans the OpenCode subprocess. The wizard does this correctly for its short lifetime; the admin server runs for hours.
- **Subprocess crash recovery:** `child.on("exit")` must trigger a respawn with exponential backoff. Surface health status in `/health` so the UI can show "Admin AI unavailable — restarting..." rather than a silent hang.
- **Suspend/resume:** when the host suspends, the SSE chat stream to the OpenCode subprocess dies. The chat UI must implement reconnect-on-focus with a clear "connection lost — reconnect?" prompt.
- **Binary discovery:** probe `~/.local/bin/opencode`, `/usr/local/bin/opencode`, sibling-of-binary path before falling back to `Bun.which("opencode")`. On macOS/Linux with GUI launchers and systemd-started processes, `~/.local/bin` may not be in PATH.

The chat UI toggle:
- **Assistant**: proxy to `http://localhost:3800` (the container's host-bound port).
- **Admin**: proxy to the host OpenCode subprocess (random port managed by admin server).
- Both proxies live in the same `Bun.serve` fetch handler. Toggle is a request header.
- **(Spike required)** Verify whether OpenCode chat uses SSE, WebSocket, or both — see §10 open questions. Bun.serve handles SSE passthrough cleanly but WebSocket proxying requires explicit `websocket` config on the Bun server.

### R5. Replace `x-admin-token` HTTP auth with cookie + Host header guard

The token only existed because containers shared a network. On host:

- Bind `127.0.0.1` by default.
- Write a per-install random secret to `~/.openpalm/state/admin/token` (mode 0600). Require it in an `httpOnly`, `SameSite=Strict` cookie set by `/login`. Token is **not rotated on restart** — only on explicit `openpalm admin rotate-token`. This prevents sessions breaking on daemon restart.
- **Add a `Host` header allowlist** (`localhost:{port}` and `127.0.0.1:{port}` only) applied as middleware to every non-static handler. Reject anything else with `400`. This closes DNS rebinding attacks that `SameSite=Strict` alone does not prevent (Plex, Transmission, and Syncthing have all been hit by this). One middleware function, applied globally.
- **Add an `Origin` header check** on state-mutating endpoints (POST/PUT/DELETE): reject if `Origin` is present and does not match `http://localhost:{port}` or `http://127.0.0.1:{port}`. This closes the `localhost`-site-sharing gap in `SameSite` handling for same-origin local dev servers.
- **Multi-user / network filesystem warning:** warn during setup (and on admin startup) if `OP_HOME` appears to be on a network filesystem. Document that the `0600` token file is not meaningful on NFS/CIFS mounts.
- Drop `localStorage` token and the `AuthGate` component entirely.

For remote admin (rare, opt-in): SSH port forwarding. Refuse `--bind 0.0.0.0` without an explicit `--insecure` flag. Document the tunnel pattern.

**Windows note:** `chmod 0600` on the token file is a no-op on Windows. Document this; the security model on Windows degrades to "anyone who can read the file can authenticate" — acceptable for a localhost tool on a single-user workstation.

### R6. Consolidate Docker handling into `@openpalm/lib`

`packages/admin/src/lib/server/docker.ts` is a re-export of `@openpalm/lib`'s docker module with a preflight wrapper. Inline the preflight into lib once. All consumers are now host-side; there is no reason for the wrapper to remain.

### R7. Simplify the scheduler co-process's call surface

Today the scheduler inside the assistant container makes HTTP calls to `admin:8100` for `api`-typed actions. After this change:

- `api`-typed scheduler actions are **removed**. Scheduler runs inside the assistant container and can only do `assistant`-type actions (call OpenCode on `localhost:4096`). That is the right scope for an isolated assistant.
- Stack-level scheduled jobs move to **OS cron on the host** via `openpalm` CLI — exactly what AKM's task model is already migrating to (commit `51f594a5`).

**Automation migration table** (not a simple rewrite):

| `type: api` action | Correct replacement |
|---|---|
| `restart_channel` | Host cron calling `openpalm restart <channel>` |
| `addon_refresh` | Host cron calling `openpalm update` |
| `snapshot` / `backup` | Host cron calling `openpalm rollback --snapshot` |
| `assistant` actions (already type: assistant) | No change |

These are not semantically equivalent to `type: assistant` — the assistant has no admin tools after R3. Users must migrate to host cron. Provide a detection command (`openpalm automations check`) that lists `type: api` tasks and their recommended replacements.

### R8. Collapse `vault/` access pattern

- Admin reads/writes vault directly through the host filesystem — no Docker mount of vault at all.
- Assistant continues to bind-mount `vault/user/` (unchanged).
- The "no other container mounts vault" rule becomes trivially enforced — no container mounts vault at all except the assistant's `vault/user/` slice.

### R9. Retire the admin compose artifacts (Phase 3)

Files to delete after Phase 2 has soaked:

- `core/admin/Dockerfile`, `core/admin/entrypoint.sh`, `core/admin/opencode/`
- `.openpalm/registry/addons/admin/compose.yml`
- The admin overlay handling in `packages/lib/src/control-plane/lifecycle.ts` (`profiles: ["admin"]` plumbing)
- `docs/technical/docker-dependency-resolution.md`

### R10. Documentation & principle updates

- Update `docs/technical/core-principles.md` security invariant #1 ("admin orchestrator") to reflect host-only admin.
- Add a new invariant: *"Admin is host-only. Containers cannot reach admin under any configuration."* Enforceable by `grep`-able rules: no `OP_ADMIN_API_URL` in container code, no admin service in any compose file.
- Add explicit note that admin bypasses guardian when talking to the assistant container (this has always been true; make it explicit so it is not accidentally changed).
- Update `docs/setup-guide.md` and `docs/managing-openpalm.md` to lead with the chat-first flow.

### R11. New principle: "UI-first, CLI-power-user"

Add to `docs/technical/foundations.md`:

> **UI-first.** The browser UI is the primary surface for both setup and ongoing operations. The CLI is the power-user surface for scripting, CI, and headless hosts. Both share `@openpalm/lib`; neither is privileged over the other in terms of capability.

---

## 6. Migration phases

### Phase 1a — Server proof-of-concept (≈1 sprint, low risk)

Goal: prove the host admin server works end-to-end before migrating routes.

- R1 (server unification, two-mode): admin server runnable via `openpalm admin`. Admin container still exists. Both paths work simultaneously via `OPENPALM_ADMIN_MODE=host|container` (default `container`).
- R2 (partial): `adapter-node` output embedded in binary via tarball extraction. Validate that `adapter-node`'s generated `index.js` does not hardcode build-time `__dirname` in its asset manifest when run from a relocated binary. This is the spike that must be validated before any migration work begins.
- R4 (partial): host OpenCode subprocess spawns and is accessible; admin toggle in chat routes to it. Signal handling and crash recovery wired.
- R5 (partial): cookie auth + Host header guard + Origin check implemented. `x-admin-token` deprecated but still accepted.

**Not in 1a:** chat UI component (built in 1b), wizard UI unification (separate sprint), route migration (in 1b).

### Phase 1b — Chat UI (≈1 sprint, new feature)

Goal: the primary user surface.

- Build the chat component from scratch: streaming response reader against OpenCode, Assistant/Admin toggle with visual thread segmentation, message history, error/reconnect handling.
- Integrate existing `voice-state.svelte.ts` speech I/O.
- Validate the OpenCode protocol spike findings (§10) before starting this work.

**Do not build this until the OpenCode SSE/WS protocol is confirmed** — the proxy implementation depends on the answer.

### Phase 2 — Route migration and cut over (≈1 sprint)

- Migrate 52 `+server.ts` routes to Bun.serve handlers calling `@openpalm/lib` directly (mechanical, parallelizable).
- Push `appendAudit()` into `@openpalm/lib` mutating functions (prerequisite for R3).
- Default `OPENPALM_ADMIN_MODE=host`.
- R5 (complete): drop `x-admin-token` entirely, remove `AuthGate` component.
- R6, R8 (vault).
- Documentation refresh: chat-first onboarding.
- Migration command for scheduler `api`-typed actions (R7).
- Admin skills allowlist and argument validation for host OpenCode.

### Phase 3 — Deletion (≈0.5 sprint)

R3, R9: delete `packages/admin-tools/`, `core/admin/`, docker-socket-proxy, admin addon compose. Safe only after Phase 2 has soaked for at least one release.

### Phase 4 — Distribution polish (later, optional)

Tauri wrapper for `.dmg` / `.msi` / `.AppImage` + system tray. Skip if `curl … | sh` is already good enough.

---

## 7. Risks & open questions

| Risk | Mitigation |
|---|---|
| **Loss of "AI manages stack" via assistant** | Re-implemented in admin's host OpenCode with the Admin toggle. User explicitly confirmed no workflow blocks on assistant→admin. |
| **Multi-user / remote-admin** | SSH tunnel is the supported path. `--bind 0.0.0.0` requires `--insecure` flag. |
| **Cross-platform host binary** (Windows) | CLI already cross-compiles for Windows. `chmod 0600` is a no-op — document it. `symlinkSync` in subprocess setup must be replaced with `copyFileSync` on `process.platform === "win32"` (current code uses `symlinkSync` which requires Developer Mode or admin). |
| **Scheduler `api` automations break** | Detect on startup, warn, provide migration table. |
| **DNS rebinding** | Host header allowlist middleware (R5). `SameSite=Strict` alone is insufficient. |
| **Prompt injection → Docker ops** | Admin skills allowlist + argument validation + confirmation prompts for destructive ops (R3). The HTTP boundary that previously sat between LLM output and Docker is gone; this must be replaced with validation at the `@openpalm/lib` boundary. |
| **Token file on network filesystem** | Warn during setup if `OP_HOME` is on NFS/CIFS. Document that `0600` is not meaningful on those mounts. |
| **Subprocess crash / laptop suspend** | Crash: respawn with backoff + surface in `/health`. Suspend: SSE dies; chat UI must reconnect-on-focus. |
| **`openpalm admin` process lifecycle** | Foreground by default. `--daemon` flag with pid file and `openpalm admin stop`. |
| **Existing E2E tests** | Already point at `http://localhost:3880`. `RUN_DOCKER_STACK_TESTS=1` gate becomes "is admin server running." |
| **GPG/pass workflow** | Moves to host where user's GPG agent lives. Removes bind-mount hack. |
| **Host without `opencode` binary** | Admin toggle disabled with clear "install OpenCode to enable AI stack management" message. Rest of admin UI still works. |
| **First-run UX** | Wizard mode of the same server. Single URL, transitions in-place from setup to chat. |

---

## 8. Open questions — spikes required before Phase 1b

These three questions must be answered with a code spike before Phase 1b work begins. Findings should be appended to this document.

### Spike 1 — Binary relocation: does `adapter-node` break out of `bun build --compile`?

**Question:** `adapter-node`'s generated `index.js` may hardcode `__dirname` (the build-time path) for its static asset manifest. If so, relocating the binary to a different path breaks static serving. Does the tarball-extract-to-cache strategy work, or does `index.js` need a path patch?

**Test:** run `bun build --compile` on a minimal SvelteKit `adapter-node` output, relocate the binary to `/tmp/`, verify the server serves `client/` assets correctly.

*Spike findings: [TBD — see investigation results below]*

### Spike 2 — OpenCode chat protocol: SSE or WebSocket?

**Question:** does the OpenCode `/chat` (or equivalent) endpoint use Server-Sent Events (SSE) or WebSocket for streaming responses? This determines the proxy implementation: Bun.serve `fetch` handler handles SSE passthrough natively; WebSocket requires the explicit `websocket` config on the Bun server.

**Test:** inspect the OpenCode source or network traffic for a live chat session. Check both the OpenCode web UI and the API used by admin's current `:3881` instance.

*Spike findings: [TBD — see investigation results below]*

### Spike 3 — OAuth callback URL with random host-OpenCode port

**Question:** the OAuth provider login flow (`/admin/opencode/providers/[id]/auth`) works by registering a callback URL with the provider. The current admin container binds to a known port (`:3881`). The host OpenCode subprocess binds to a random port. Provider OAuth apps registered with fixed callback URLs will break if the callback URL changes between runs.

**Test:** trace the OAuth flow in `packages/admin/src/routes/admin/opencode/providers/[id]/auth/` and `packages/admin/src/lib/server/opencode/oauth.ts`. Determine whether the callback URL is admin-server-side (`:3880`, stable) or OpenCode-subprocess-side (random port, unstable). If the latter, determine whether a stable admin-side proxy for OAuth callbacks is feasible.

*Spike findings: [TBD — see investigation results below]*

---

## 9. Why this is also a security upgrade

The current model relies on:
1. The admin token in `localStorage` not leaking.
2. `docker-socket-proxy` filter rules being correct and exhaustive.
3. The `admin_docker_net` network isolation holding.
4. Every channel/addon's compose config not accidentally exposing the admin port.
5. Admin living on `assistant_net` alongside guardian and assistant — reachable by any container that reaches that network.

The new model relies on:
1. The OS-level loopback boundary (`127.0.0.1`). Containers cannot route to the host loopback. Enforced by the kernel, not a YAML allowlist.
2. Host header allowlist (closes DNS rebinding).
3. `httpOnly` + `SameSite=Strict` cookie + Origin check (closes CSRF).
4. Admin skills allowlist + argument validation (closes LLM prompt injection → Docker ops path).

Net verdict: **better on balance**. The elimination of the containerized attack surface is genuine. The new risk — prompt injection into the host OpenCode subprocess — is real but mitigatable with validation at the lib boundary, and it replaces a larger, less-mitigatable set of container-network risks.

---

## 10. Measurable simplification

| Thing | Before | After |
|---|---|---|
| Container images to build/publish | base, assistant, guardian, **admin**, channel | base, assistant, guardian, channel (−1) |
| Compose services in a default install | init, assistant, guardian, **admin, docker-socket-proxy** | init, assistant, guardian (−2) |
| Networks | `assistant_net`, `channel_lan`, **`admin_docker_net`** | `assistant_net`, `channel_lan` (−1) |
| Packages under `packages/` | 10 | 8 (drop `admin-tools`, fold admin build into CLI) |
| OpenCode instances in Docker | 2 (assistant + admin containers) | 1 (assistant only) |
| HTTP auth layers | `x-admin-token` + `OP_ASSISTANT_TOKEN` | cookie (admin) + `OP_ASSISTANT_TOKEN` (guardian↔assistant only) |
| Container env vars | `OP_ADMIN_API_URL`, `OP_UI_TOKEN`, `OP_ADMIN_BIND_ADDRESS`, `OP_ADMIN_PORT`, `OP_ADMIN_OPENCODE_PORT`, `OP_ADMIN_OPENCODE_BIND_ADDRESS`, `DOCKER_HOST` | All gone from container env |
| Docs existing purely because of admin-in-Docker | `docker-dependency-resolution.md` | Deleted |
| First-run UX codebases | Wizard (hand-rolled HTML/JS) + post-install admin UI (SvelteKit) — two separate codebases | One SvelteKit app, modal first-run state |
| Default landing for new users | Admin dashboard with cards | Chat with stack toggle |

---

## Appendix A — Route inventory (1:1 migration, not consolidation)

Every current admin `+server.ts` route migrates 1:1 to a Bun.serve handler calling `@openpalm/lib`. There are 52 routes across 17 route groups. This is a mechanical migration, not a consolidation. Each route group maps as follows:

| Route group | Count | Post-migration: Bun.serve handler → |
|---|---|---|
| `/admin/capabilities` | 1 | `readStackSpec`, `writeStackSpec` |
| `/admin/install` | 1 | `performSetup`, `applyInstall` |
| `/admin/containers/{up,down,restart,pull}` | 4 | `runDockerCompose` |
| `/admin/secrets`, `/secrets/generate`, `/secrets/user-vault` | 3 | host filesystem + `@openpalm/lib` secrets |
| `/admin/audit`, `/admin/logs` | 2 | reads `~/.openpalm/state/logs/` |
| `/admin/providers`, `/providers/save`, `/providers/toggle`, `/providers/model`, `/providers/local`, `/providers/custom` | 6 | `@openpalm/lib` provider config |
| `/admin/opencode/providers/[id]/auth` | 1+ | host OpenCode subprocess (see Spike 3) |
| `/admin/opencode/status`, `/opencode/model` | 2 | host OpenCode subprocess |
| `/admin/automations`, `/automations/catalog` | 2+ | `akm tasks` CLI on host |
| `/admin/addons`, `/addons/[name]` | 2 | `@openpalm/lib` registry + lifecycle |
| `/admin/config/validate` | 1 | `@openpalm/lib` validation |
| `/admin/installed`, `/admin/install`, `/admin/update`, `/admin/upgrade`, `/admin/uninstall` | 5 | `@openpalm/lib` lifecycle |
| `/admin/artifacts` | 2 | `@openpalm/lib` artifacts |
| `/admin/network/check` | 1 | network health check |
| `/guardian/health` | 1 | proxy to guardian |
| `/health` | 1 | admin server health |
| All remaining | ~17 | same pattern |

Total: ~52 routes, all mechanical. Estimate 20–30 min each = 2–3 person-days, parallelizable.

---

## Appendix B — What the CLI looks like after this lands

```
openpalm                  # default: starts admin UI, opens browser
openpalm admin            # explicit form of the above
openpalm admin stop       # stop the daemon
openpalm admin rotate-token  # rotate the session token
openpalm install          # first-run wizard (same UI, wizard mode)
openpalm start            # compose up; no UI
openpalm stop             # compose down
openpalm restart          # compose restart
openpalm status           # JSON status to stdout
openpalm logs <svc>       # tails logs from a service
openpalm chat assistant   # headless chat with the user assistant
openpalm chat admin       # headless chat with the admin OpenCode
openpalm scan             # diagnostics
openpalm automations check  # list type:api tasks needing migration
openpalm self-update      # CLI/UI binary update
openpalm rollback         # snapshot rollback
openpalm uninstall        # full teardown
```

Power users keep everything they have today. New users never need to type any of it.

---

## Appendix C — Spike investigation results

*(To be filled in by spike agents — see §8)*

### Spike 1 result: Binary relocation

**Verdict: STRATEGY WORKS AS PROPOSED.**

The single path anchor in the generated `build/handler.js` (the `adapter-node` output) is:

```js
const dir = path.dirname(fileURLToPath(import.meta.url));
const asset_dir = `${dir}/client${base}`;
```

`import.meta.url` resolves to the URL of the **currently executing file at runtime**, not the build-time location. If `handler.js` lives at `~/.openpalm/cache/admin/0.11.0/handler.js`, `dir` resolves to that cache directory — exactly where the `client/` and `prerendered/` sibling directories are after tarball extraction. No hardcoded build-time path is baked in.

`svelte.config.js` and `vite.config.ts` contribute nothing path-specific to the compiled output.

**The "extract tarball to `~/.openpalm/cache/admin/{version}/`, then run `bun build/index.js`" approach is correct.** No path patch needed. The tarball must preserve the internal structure (`build/index.js`, `build/handler.js`, `build/client/`, `build/prerendered/`) with relative paths intact — standard `tar` extraction guarantees this.

Note: the wizard's `with { type: "text" }` inline-import pattern is not applicable to the full SvelteKit build (hundreds of code-split files) and should not be attempted.

---

### Spike 2 result: OpenCode chat protocol

**Verdict: PLAIN HTTP POST — FETCH PASSTHROUGH WORKS.**

OpenCode exposes a plain HTTP REST API — no SSE, no WebSocket. Every client in this repo communicates with OpenCode over ordinary `fetch()` calls returning a complete JSON body. The key endpoints (confirmed in `packages/channels-sdk/src/assistant-client.ts`):

```
POST /session                          → { id: string }
POST /session/:id/message              → { parts: [{ type, text }, ...] }
```

`sendMessage` does a plain blocking POST and awaits the **complete JSON body** — no streaming, no chunked-transfer reading. Responses can take 30–120s (LLM inference); the proxy must not impose a short request timeout.

A `Bun.serve` `fetch` handler proxies this with `return new Response(upstream.body, { headers: upstream.headers })`. No `websocket:` config block is required.

**One gotcha:** when `OPENCODE_SERVER_PASSWORD` is set, OpenCode requires `Authorization: Basic <base64>`. The proxy must forward this header unchanged.

Zero uses of `EventSource`, `WebSocket`, `ws://`, or `text/event-stream` exist anywhere in the codebase.

---

### Spike 3 result: OAuth callback URL

**Verdict: STABLE — no changes needed.**

The OAuth flow uses a dedicated **OpenCode auth subprocess** (`packages/admin/src/lib/server/opencode-auth-subprocess.ts`) that is entirely separate from the main assistant OpenCode instance. It already runs on the host loopback at a random port — this is not a Docker concern.

For `auto` (PKCE) mode, OpenCode **constructs the redirect URI internally** pointing to `http://127.0.0.1:<random-port>/...`. This is the loopback redirect the OAuth provider sends the browser back to. Because RFC 8252 exempts `localhost`/`127.0.0.1` redirect URIs from pre-registration, no OAuth app needs a fixed callback URL configured.

The stable admin port (`:3880`) is used only for control-plane API calls and as a transparent proxy between the browser and the auth subprocess — never as the registered redirect target.

Moving admin from Docker to a host Bun process has no effect on this design. The auth subprocess already runs on the host loopback. **No changes to the OAuth implementation are required.**
