# Assistant UI serving & LAN access — brittleness review

Status: implemented (§4 delivered; see "Implementation status" at the end)
Date: 2026-07-29
Scope: everything that decides where the OpenPalm UI and OpenCode are served,
bound, published, advertised, and authenticated — `packages/cli` (ui-server,
ports), `packages/electron` (main, local-opencode), `packages/ui`
(hooks.server, helpers, opencode-target, port-contract, `/oc` + `/voice`
routes, session/basic auth), `packages/lib/src/control-plane` (access-toggles,
bind-warning, config-persistence, assistant-endpoint, mdns-responder,
ui-runtime-config, opencode-client), `packages/skeleton` compose,
`containers/assistant`, and the docs that describe them.

Method: seven parallel subsystem reviews (serving harnesses, access toggles,
request gating, OpenCode path, compose/skeleton, docs-vs-reality, git-history
archaeology) producing 72 findings; the six high-severity bug claims were then
independently, adversarially re-verified against the code — **all six were
confirmed**. Three independent simplification designs (radical collapse,
incremental hardening, user-expectation-first) were drafted from the verified
findings and synthesized into the plan in §4.

---

## 1. Diagnosis — why this area feels brittle

The brittleness is structural, not incidental, and it reduces to four
patterns. The churn history proves each one has already caused shipped
regressions (the network-access model is on its **fifth architecture in ~6
months**: Caddy segmentation → loopback-only env pairs → `OP_BIND_ADDRESS`
cascade (#395) → presets (#563, deleted mid-beta) → flat toggles; and per
`access-presets-redesign.md`, "open the assistant from your phone" **never
worked in any released version** — three stacked failures each masked the
next).

**P1. The same question is answered independently in 3–7 places.**
"Which port is the UI on?" has ~7 sources of truth (`--port`, `PORT`,
`OP_HOST_UI_PORT` env vs persisted — honored by CLI, ignored by Electron —
three independent `3880` constants, plus inline fallbacks). "Which URL is the
assistant on?" has 4 divergent precedence chains
(`assistant-endpoint.ts` — the file whose header says it is "the ONE place
this precedence is decided" — vs `opencode-target.ts` vs CLI
`isAssistantHealthy` vs Electron's eagerly-baked `OP_OPENCODE_URL`). The
3800/3810 port swap is implemented **three times** with heuristics that
disagree at the edges. Credential encoding is implemented three times. The
locked `/oc` connection seed has three writers in two languages, pinned
together by tests that grep shell source for JS fragments.

**P2. Intent is stored only as its own consequences.**
The toggles fixed half of this (they are derived *into* env), but reads still
go backwards: `readAccessToggles()` infers intent from bind addresses, with
legacy `OP_BIND_ADDRESS`/`OP_CHAT_BIND_ADDRESS` fallbacks consulted forever —
on files where compose semantics are flat. Display and reality can invert
(restored backup, hand edit), and the next save makes the wrong reading real.
This exact mechanism has already both silently widened a deliberately-closed
bind and silently dropped LAN reachability (commit 16263be et al.).

**P3. Writes and applies are decoupled, and every advertised "apply" is a
no-op.** Toggle saves write stack.env and flip mDNS immediately, but the bind
addresses/`OPENCODE_AUTH`/`GUARDIAN_DIRECT_INGRESS` are consumed only by
compose interpolation at container *recreate* — and both the Containers-tab
restart button and `openpalm restart` run `compose restart`, which never
re-reads them. Intent, mDNS advertisements, host-proxy auth behavior, and
actually-published ports can disagree for an unbounded window.

**P4. History lives in the request path instead of in migrations.**
`port-contract.ts` re-implements the on-disk port-swap migration as a
process-local, per-boot patch driven by magic literals (`'3800'` in env ⇒
"legacy default", clobbering an operator who deliberately chose 3800), then
sniffs whether `OP_OPENCODE_URL` "looks generated" to decide whether to delete
a value another process baked in. Every such shim is a second implementation
of a migration that must agree with the first forever.

One more structural fact that surprises everyone (and is invisible in the
product): **there are two parallel UI serving paths**. The host UI (CLI
supervisor / Electron, port 3880, admin-capable, loopback-pinned except the
`OP_ALLOW_REMOTE_SETUP` escape hatch) and the assistant container's co-process
(in-container 3000, published at `${OP_UI_BIND_ADDRESS}:${OP_UI_PORT:-3800}`,
non-admin, voice hard-disabled). The LAN toggle affects only the container
copy; both present identical chrome and accept the same password, so nothing
tells a user which one they are on or why voice/admin works on one and not the
other.

---

## 2. Confirmed broken today (all independently verified against code)

1. **CLI first-run wizard dead-ends.** `openpalm install` / bare `openpalm` on
   a fresh machine serves a **non-admin** UI (`install.ts:361-367` passes no
   `adminHostUi`), whose `/setup` 403s (`host:setup` capability gate) while
   every other page redirects *to* `/setup`. The documented front door of the
   product is a redirect→403 loop. Two vitests each pin one half of the loop
   as correct; no test exercises the composition.

2. **Toggle changes never apply through any advertised path.** The Assistant
   tab says "Restart the assistant container to apply them", but restart is
   `compose restart`, which cannot change port publishes or container env
   (needs `up -d` recreate). Corollaries: toggling `assistantDirect` off
   401-kills `/oc` chat (host proxy drops Basic auth immediately; the
   container still requires it); guardian toggles flipped post-install publish
   ports with no service behind them (the addon auto-enable exists only in
   `performSetup`); mDNS advertises `<name>.local` for a port that refuses
   connections.

3. **`/oc` aborts any chat turn longer than 30s.**
   `UPSTREAM_HEADER_TIMEOUT_MS=30_000` in `routes/oc/[...path]/+server.ts`,
   but OpenCode's message POST returns headers only at turn completion, and
   `/oc` is the locked default connection on every install. Tool-use or
   long-reasoning turns → 502 `assistant_unreachable` at 30s (the client's own
   budget is 150s).

4. **`createOpenCodeClient` sends no auth.** The moment `assistantDirect` is
   on (`OPENCODE_AUTH=true`, OpenCode requires Basic auth for *all* clients
   including loopback), every consumer of `getOpenCodeClient()` — provider
   list/write, models, assistant-model, setup status — 401s. Three *other*
   call sites each re-implement credential attachment correctly; this one was
   missed because there is no shared helper.

5. **Under Electron, `/oc` chat targets the wrong OpenCode.**
   `getHostOpencodeTarget()` prefers the per-launch admin child
   (`local-opencode.runtime.json`) over the stack assistant. The admin child's
   staged HOME deliberately has **no provider credentials**, so the browser's
   locked "Local assistant" connection routes chat to an OpenCode that cannot
   chat by design; `/api/host/health` reports the wrong server's health; a
   stale runtime.json after an Electron crash hijacks `/oc` for CLI-served UIs
   on the same home too (no pid/liveness check).

6. **Electron attaches blindly to whatever answers its port.** No
   instance-identity probe, no readiness-vs-child-exit race (the CLI has both
   — D1). Bare `openpalm` already on 3880 + launching the desktop app ⇒
   Electron's own child dies of EADDRINUSE (exit handler only logs) and the
   window opens onto the foreign non-admin UI.

Adjacent confirmed security issues found on the way: the session cookie
signing key `op_session_signing_key` is not in `DELEGATED_SECRET_NAMES`, so it
lands in `knowledge/secrets/` — **mounted into the assistant container at
`/stash`** — defeating the threat model its own docstring states (G1 moved the
login password out of exactly this location). And the container UI co-process
reads its login password file-first from an assistant-writable home, so an
agent/plugin write can silently repoint the LAN UI's password.

---

## 3. The drift inventory (the medium-severity mass)

Grouped by the pattern from §1; file:line details in the finding log
(session artifact) and reproducible from the code.

- **P1 duplicates:** parent computes the child's HOST/PORT/ORIGIN then the
  child recomputes and overwrites it (`ui-server.ts:276-284` vs `328-335`);
  Electron's env spread is inverted (persisted stack.env beats live env,
  opposite of every other resolver); Electron ignores persisted
  `OP_HOST_UI_PORT`; `OP_VOICE_PORT_HOST` split-brain (compose reads
  stack.env, `voiceHostPort()` reads only process.env — the UI's own error
  message walks users into the broken half); `OP_UI_PORT` means the *host*
  port in compose and the *in-container listen* port in the entrypoint,
  kept apart only by comments; three hardcoded copies of guardian
  3830 / OpenCode 4096 ports.
- **P2 inference:** legacy bind fallbacks honored forever on flat files; PUT
  `/api/host/stack` round-trips *all six* derived keys even when `access` is
  omitted, normalizing a hand-set concrete bind (`192.168.1.50` → `0.0.0.0`)
  on an unrelated save — despite its own comment promising it never moves a
  bind; the D9 exposure log reads process.env before stack.env promotion, so
  it never fires in host processes (dead code as shipped).
- **P3 apply-gap:** mDNS reconcile is a per-process singleton — only the
  process serving the PUT reconciles; siblings advertise stale names forever;
  the container UI's crash-loop give-up leaves the *one published port* dead
  while the healthcheck stays green (Docker can't heal a healthy container);
  neither host supervisor notices UI-child death after startup (CLI keeps
  running with a dead port; Electron keeps a dead window — only the container
  entrypoint respawns, while claiming in a comment the hosts do too).
- **Gating:** `handle()` chains ~10 order-dependent gates with exemption
  lists duplicated in four places; SvelteKit's built-in form-CSRF check is a
  fourth, unmanaged origin gate that 403s multipart voice uploads over SSH
  tunnels (ORIGIN is pinned, tunnel origin differs); `checkOriginHeader` runs
  twice per admin mutation; LAN reachability requires three values mirrored by
  hand (compose port bind ↔ `OP_UI_BIND_ADDRESS` env copy ↔ entrypoint
  container marker) — any divergence yields "TCP accepts, then 400
  invalid_host on every request", the exact reported symptom.
- **Docs-vs-reality:** `remote-access-tls.md`'s central Guardian step
  (loopback bind + `GUARDIAN_DIRECT_INGRESS=true`) is a state the toggle
  model **cannot represent** — the next save silently reverts it; the pairing
  endpoint still instructs the retired hand-edit workflow that produces that
  state; the `/oc` proxy — the linchpin of LAN access — appears in no route
  inventory doc (api-spec's only `/oc/*` is the guardian's, a different server
  with a different auth model); no user-facing doc anywhere states the URL to
  type on a phone (`http://<name>.local:3800` exists only in a technical doc);
  the TLS guide opens a 0.0.0.0 listener and then tells users to firewall it,
  because "trust proxy headers" and "widen the bind" are one flag; compose
  claims voice is served through the container UI, which 503s `/voice` by
  design — LAN users silently have no voice.

---

## 4. Recommendation

The three design exercises converged. Rules first, then phases. The rules are
what prevent redesign #6:

1. **Intent is stored once and applied transactionally.** A toggle save is
   not done until Docker reflects it. Display comes from stored intent (and
   observed actuals), never re-inferred from bind values.
2. **One resolver per question, in `packages/lib`.** Port, bind, origin,
   assistant URL, credential — one function each; harnesses call it, never
   re-implement it.
3. **The process that binds the socket owns its network env.** Parents pass
   capability + home + port, nothing else.
4. **History lives in disk migrations run at serve-entry, not in the request
   path.** Once a migration is guaranteed to have run, its process-local shim
   is deleted.
5. **The LAN lane trusts only injected env.** The container co-process never
   derives auth/install state from the assistant-writable home.

### Phase 0 — correctness fixes inside the current shape (small, independent, ship now)

| # | Fix | Touches |
|---|---|---|
| 0.1 | Wizard serves admin: pass `adminHostUi: true` in `runWizardInstall` (+ one composed e2e test that spawns the UI the way the wizard does) | `cli/src/commands/install.ts:361-367` |
| 0.2 | Delete the `/oc` 30s header timeout (loopback upstream fails fast on its own; keep client-abort forwarding) + a delayed-header vitest | `ui/src/routes/oc/[...path]/+server.ts` |
| 0.3 | One credential helper: `OpenCodeClientOpts` gains username/password; `/oc`, `opencodeFetch`, health route, and `createOpenCodeClient` all use one `authHeadersFor(target)` built on `basicAuthHeader` | `lib/control-plane/opencode-client.ts`, `ui/.../basic-auth.ts`, 4 call sites |
| 0.4 | `/oc` and `/api/host/health` always target the **assistant**: split `getAssistantOpencodeTarget()` (env-derived only) from the Electron-child target; ignore `local-opencode.runtime.json` when `OP_UI_SERVED_IN_CONTAINER=1`; add a pid + liveness check before trusting it anywhere | `ui/src/lib/server/opencode-target.ts`, `routes/oc`, `api/host/health` |
| 0.5 | Toggle saves apply themselves: shared `applyAccessToggles()` = write env → guardian-addon auto-enable (extracted from `performSetup`) → scoped `compose up -d` via the existing activation lock → reconcile mDNS *after* success. Delete the "Restart the assistant container to apply them" toast | `routes/api/host/stack/+server.ts`, `lib/control-plane/setup.ts:471-498`, `AssistantTab.svelte` |
| 0.6 | Electron adopts the CLI's attach protocol: move `checkExistingUiInstance` + the readiness-vs-exit race into the shared `UiSupervisor`; delete `killStaleUIServer` + the pid file (identity probe supersedes pid kills) | `lib/.../ui-supervisor.ts`, `electron/src/main.ts`, `cli/src/lib/ui-server.ts` |
| 0.7 | Secrets: add `op_session_signing_key` to `DELEGATED_SECRET_NAMES` + one-time relocation; container co-process reads login password from injected secret **only** | `lib/.../secrets-files.ts`, `ui/.../session-store.ts`, `containers/assistant/entrypoint.sh` |

Each closes at least one verified HIGH; none changes architecture.

### Phase 1 — one owner per question (the real de-brittling, one release)

- **Network contract module** (`lib/control-plane/network-contract.ts`): the
  only `3880` in the tree, `resolveHostUiPort(env, persisted)`, and the bind
  derivation. Child owns HOST/ORIGIN derivation; parents pass `PORT` +
  capability flags only (delete the parent-side copy — it is dead on arrival
  today). Electron reads persisted `OP_HOST_UI_PORT` through the same
  resolver and fixes its inverted env precedence. One loopback spelling
  (`127.0.0.1`) everywhere.
- **One assistant resolver**: `resolveAssistantEndpoint` becomes the single
  URL chain; `opencode-target.ts` shrinks to credential resolution;
  CLI `isAssistantHealthy` uses it (fixes needless `up -d` on custom ports);
  Electron stops baking `OP_OPENCODE_URL`, resolution goes lazy in the child.
- **Delete `port-contract.ts` entirely**: every serve entry (CLI, Electron)
  runs `runHomeMigrations` under the lifecycle lock before spawning; add one
  schema-gated migration that sanitizes the *consolidated* `state/stack.env`
  (apply the 3800/3810 swap once, strip `RETIRED_BIND_KEYS`). Then delete the
  process-local swap, the `'3800'`-literal heuristics, and
  `isGeneratedAssistantUrlForPort`.
- **Store intent as intent**: persist the four toggle booleans as literal
  keys in stack.env alongside the generated row; `readAccessToggles` becomes
  a direct read; delete the legacy fallbacks and `isUiLanExposed` (unused,
  contradictory). PUT with `access` omitted leaves all six derived keys
  untouched.
- **One origin gate**: `kit.csrf.checkOrigin=false` (rely on the audited
  `checkOriginHeader`); delete the duplicate check in `withAdminBody`; split
  `OP_ALLOW_REMOTE_SETUP` into `OP_TRUSTED_PROXY` (loopback bind + forwarded
  headers — what every documented TLS/Tailscale/Caddy topology actually
  needs) vs the rare wildcard-bind case; delete both "now firewall the port
  we opened" doc instructions.
- **Container UI hardening**: hardcode in-container port 3000 (kill the
  `OP_UI_PORT` name collision + ~30 lines of healthcheck comments); relax the
  Host allowlist on the entrypoint marker alone (drop the hand-mirrored
  `OP_UI_BIND_ADDRESS` requirement — with a login wall, rebinding yields only
  `/login`); pin install/landing state when `OP_UI_SERVED_IN_CONTAINER=1`;
  crash-loop ⇒ healthcheck FAILS (a green container with a dead published
  front door is the worst diagnostic state the stack can produce); replace
  the inline `node -e` runtime-config writer — the locked `{baseUrl:'/oc'}`
  seed becomes a constant in the UI, not three writers in two languages.
- **Decide the Electron admin child's fate.** Its broker was deleted in
  Phase 3b; its only remaining consumer is the accidental `/oc` hijack fixed
  in 0.4. Either delete `local-opencode.ts` (~400 lines + the
  runtime/pid/unavailable file trio) or advertise it explicitly as
  `adminOpencodeUrl` consumed only by the surface that wants it — never as a
  silent default. Recommendation: delete; reintroduce deliberately if a
  host-admin agent ships.

### Phase 2 — make the promise visible (product work)

- `GET /api/host/access-status`: per listener — intent (toggles), actual
  (published ports via the landing resolver's existing `compose ps`
  plumbing), a loopback self-probe verified via `/api/runtime` identity, and
  the concrete LAN URLs. Surface in the Assistant tab and the wizard's
  completion screen: **"Open this on your phone: `http://<host>.local:3800`
  / `http://<ip>:3800`"** with a reachability chip. This is the single most
  predictable support question and no user doc currently answers it.
- mDNS honesty: advertise a name only after the self-probe confirms the port
  answers; interval-reconcile (60s) inside the responder instead of
  call-site wiring, so every host process converges; document that `.local`
  lives only while a host `openpalm` process runs — the IP URL is the promise.
- Close the `assistantDirect` loop: show the generated key where the toggle
  copy already promises it; fix the rotation hint's wrong path and retired
  preset reference; the pairing endpoint offers the `guardianNetwork` toggle
  action instead of instructing the unrepresentable hand-edit.
- Voice on the LAN UI: give the container co-process a real voice upstream
  over the compose network (or document loudly that voice is host-UI-only).
- Docs sweep: `/oc` into ui-route-map/api-spec (disambiguated from the
  guardian's `/oc`), LAN URL into setup-guide/managing-openpalm,
  troubleshooting entry for "`.local` stopped resolving", fix the compose
  voice comment and README's "OpenCode web interface" misnomer.

### Phase 3 — guardrails so it stays simple

1. **A two-device LAN e2e**: enable `networkAccess`, hit `:3800` from a
   non-loopback source (second container on a user-defined network), assert
   login → `/oc` chat round-trip → `/voice`. Every serial LAN failure in the
   history shipped because nothing exercised this path.
2. **Derivation-matrix vitest for `opencode-target.ts`** (currently zero
   direct coverage; the `/oc` suite mocks the resolver — three of the six
   HIGHs would have been caught here).
3. **Harness-parity test**: CLI, Electron, and container resolve identical
   port/bind/assistant-URL answers from identical homes.
4. **Literal ban** in `skeleton-guardrail.test.ts`: no new `3880`/`3800`/
   `3810` constants outside `lib` defaults + compose interpolation fallbacks.

### Net effect

Three files deleted outright (`port-contract.ts`, `local-opencode.ts`, the
runtime/pid file trio), the entrypoint's UI supervision roughly halved, and
the counts that matter: 7 port authorities → 1, 4 assistant-URL chains → 1,
3 port-swap implementations → 1 (run once, on disk), 3 runtime-config
writers → 0, 4 origin gates → 1, 3 credential encoders → 1 — and exposure
intent stored once, applied transactionally, and *provable in the dashboard*.
The absence of exactly these properties is what caused four access-model
rewrites in five releases.

---

## Implementation status

All four phases of §4 landed. Recorded here because the plan above is written in
the future tense and would otherwise read as outstanding work.

### Delivered

**Phase 0** — every one of the six verified defects, plus the two security holes
found alongside them:

| Fix | Commit |
|---|---|
| Wizard served from an admin-capable process; the UI no longer redirects to a `/setup` it would refuse | `9194706` |
| `/oc` no longer aborts chat turns past 30s | `2451342` |
| Every OpenCode call targets the assistant, not Electron's credential-less admin child | `fa15fca` |
| One credentialed client and one encoder (`createOpenCodeClient` sent no auth) | `536d287` |
| Toggle saves apply themselves — write, reconcile addons, recreate, then advertise | `74277db` |
| Session signing key out of the assistant-readable stash; container UI trusts only its injected password | `ce7059c` |
| Electron probes for an existing instance instead of killing a recorded pid | `333fa1a` |

**Phase 1** — the consolidation, by the numbers: 7 port authorities → 1
(`701ddc6`), 4 assistant-URL chains → 1 and 3 port-swap implementations → 1
run-once disk migration with `port-contract.ts` deleted (`3379fe7`), 4 origin
gates → 1 plus `OP_TRUSTED_PROXY` split from bind-widening (`2fe8619`), intent
stored rather than inferred (`64ae6cb`), the container UI hardened (`d87c9e6`),
and the unread Electron admin OpenCode child deleted (`6da1779`).

**Phase 2** — `GET /api/host/access-status` and the "open this on your phone"
card (`b85fc69`); mDNS converged across processes and gated on a self-probe
(`c5f6b7e`); the generated assistant key finally servable, with the stale
rotation and pairing copy corrected (`84a3f38`); the docs sweep (`3c7ec8e`).

**Phase 3** — harness-parity table, the port-literal ban, and the LAN e2e
(`b9abe09`), then the last duplicate port constants retired so the ban's
allowlist holds only the unavoidable browser-side cases (`a6a67a5`).

### Deliberately not done

**Voice on the LAN UI** (§4 Phase 2, R14). `services.compose.yml:4-11` keeps
voice on `addon_net` and never `assistant_net` as an explicit addon trust
boundary (S.6b / D3(b)): "a compromised addon image cannot reach the
assistant's" API. Giving the container UI a route to voice means either putting
voice on `assistant_net` or adding a network — a security-boundary decision that
belongs to a deliberate change, not to this refactor. The asymmetry (voice works
on the host-served UI, not the LAN-published container UI) is now documented in
`docs/troubleshooting.md` instead of being a silent surprise.

### Follow-up this work surfaced

**The guardian has no proxy-trust equivalent.** `OP_TRUSTED_PROXY` lets the host
UI sit behind TLS while staying loopback-bound, which is why
`remote-access-tls.md` no longer tells operators to firewall a port OpenPalm
opened for them. The guardian still has no such option: `resolveAccessEnv`
derives both `OP_GUARDIAN_BIND_ADDRESS` and `GUARDIAN_DIRECT_INGRESS` from the
single `guardianNetwork` boolean, so fronting the guardian with TLS genuinely
requires opening its LAN bind — and the doc still carries a compensating
firewall step for it. The same split would remove it.

### Verification

`bun run check` 0 errors (1316 files); `bun run lint` clean (845 files);
`packages/ui` server project 1509 pass (160 files); Electron 104 pass; root
`bun run test` 1812 pass, up from 1703, with the failing-test NAME SET
byte-identical to the pre-change baseline. Those 147 failures are pre-existing
in a sandbox with no Docker and no network, and are unrelated to this subsystem
— they were measured before any change on this branch and compared by name, not
count, after every commit.

The LAN e2e (`packages/ui/e2e/lan-access.stack.ts`) is verified to collect but
is UNEXECUTED here: it needs Docker and a real network interface. Running it is
the one outstanding validation of the headline claim.
