# OpenPalm Public-Seams Review — Findings & Recommended Fixes

**Date:** 2026-07-26
**Reviewed at:** `main` @ `a73a6b4` · package version `0.13.0-beta.13`
**Scope:** the public seams a real user touches — CLI install/lifecycle, the Docker Compose stack, the web/Electron admin surfaces, distribution/release packaging, and the Discord/Slack portal + guardian message path.

## About this review

This is a **point-in-time, documentation-blind audit**. Every finding was derived **only** from the implemented code and configuration — README/CHANGELOG/`.env.example` claims were deliberately ignored, and are noted only where they *contradict* the code. Each finding was confirmed by reading the implementation (file:line evidence below). Each recommended fix was then checked against the real code for feasibility (that the exports/functions it relies on exist, the exact edit sites, and that it doesn't break existing tests or behaviour), and independently adversarially audited.

**Constraint acknowledged:** desktop-app **code-signing is an accepted limitation** (the project cannot afford signing/notarization fees). No paid signing is recommended anywhere in this report. Note that Docker **image** signing via cosign *keyless* (GitHub OIDC + Sigstore) is free and is therefore recommended where relevant (finding E4) — it is not covered by the code-signing exclusion.

**Verification outcome:** 25 findings — 23 confirmed as originally stated, **2 corrected** during deeper verification (headline overstated; a narrower real gap remains). The corrections are called out explicitly below, because they matter for calibrating confidence in the rest.

---

## What OpenPalm is (as implemented)

Stripped of its documentation, OpenPalm is a **self-hosted personal-AI stack managed through Docker Compose**, with a compiled Bun CLI (`openpalm`) as the host-side control plane. The functional core is the `assistant` container running **OpenCode** — a full coding-agent runtime that bakes in `claude-code`, `codex`, `copilot`, `gh`, `gcloud`, `python3`, `git`, and more (`containers/assistant/Dockerfile:38-46`) — with a default permission policy of `bash "*":"allow"` (`packages/skeleton/system/assistant/opencode.jsonc:73-81`). Around it:

- a **guardian** reverse proxy (auth, per-user session ownership, rate limiting, fail-closed content moderation) that portal traffic must traverse to reach the assistant;
- a **web admin UI** (SvelteKit) served by the CLI on `127.0.0.1:3880`, plus a non-admin copy inside the assistant container on `:3800`;
- an **Electron desktop wrapper** that spawns the same host UI server (it does not manage Docker itself);
- optional **Discord/Slack portals**, local-LLM (Ollama), voice (Whisper/Kokoro), and an OpenAI-compatible API endpoint.

Everything binds to loopback by default; four explicit "access toggles" open individual listeners to the LAN, and a fresh install has all four off (`packages/lib/src/control-plane/access-toggles.ts:57-62`). The runtime architecture is thoughtfully designed — real network segmentation, fail-closed moderation, transactional deploy with rollback, CSPRNG secrets. The weaknesses documented here are concentrated at the **edges a non-technical user actually touches** (distribution, lifecycle, cross-platform reality) and in the **agent trust model** once portals or LAN toggles are enabled.

---

## Two corrections to the first-pass review

- **Air-gapped boot (E2): overstated.** The assistant does **not** hard-fail boot when npm is unreachable. The `exit 1` in the assistant entrypoint fires only when *no* skeleton version resolves at all (a build-misconfiguration guard); `PLATFORM_VERSION` is baked into every release image, so it is always set. The actual `npm install @openpalm/skeleton` **soft-continues** on failure. The real, narrower gap: the assistant image bakes **no** skeleton fallback floor (the guardian image does), so an air-gapped *first* boot on a fresh volume runs without its managed OpenCode config.
- **Rootless Linux (F1): overstated.** Core services are **not** unprotected under rootless Docker — they use a *different* mitigation than voice: a `docker run alpine chown` ownership-reconcile pass plus arbitrary-uid Dockerfiles, instead of voice's drop-`user:` overlay. Generalizing voice's overlay would actually **regress** that design and break the `guardian-rootless`/`portal-rootless` guardrail tests. The real residual: the chown pass is wired into `start`/`upgrade`/`up` but **not** the initial install path, so a one-shot fresh rootless install's first `up` can hit unwritable dirs before any chown runs.

---

## Severity summary

| # | Issue | Severity | Fix effort | Fix verdict |
|---|-------|----------|-----------|-------------|
| G1 | Agent can `cat /stash/secrets/*` → total credential compromise | **Critical** | medium | partial (needs doc/migration follow-through) |
| A1 | `npm install -g openpalm` is broken | High | medium | needs-refinement |
| B1 | Windows installer has no checksum verification | High | small | sound |
| C1 | `uninstall --purge` leaves `state/`+`system/`, blocks reinstall | High | trivial | sound |
| C3 | Lost UI password = permanent lockout, no reset | High | small | partial |
| D1 | Day-2 `start/stop/…` show blank/raw Docker errors | High | small | sound |
| G2 | `bash "*":"allow"` auto-approves arbitrary shell | High | medium | sound |
| G3 | Portals default-open (empty allowlist = unrestricted) | High | small | sound |
| B2 | Windows PATH not persisted | Medium | small | partial (registry gotcha) |
| B3 | PowerShell 7+ hard-required on stock Windows | Medium | small | sound |
| B4 | No windows-arm64 build; self-update blocked on Windows | Medium | medium | sound |
| B6 | Secret file perms are a no-op on Windows (no ACL) | Medium | medium | partial |
| C2 | No CLI `doctor`; preflight only in the browser wizard | Medium | medium | partial |
| E1 | Image tags default to moving `:latest` | Medium | medium | partial |
| E3 | Voice image published out-of-band; silent drift | Medium | medium | sound |
| E4 | All images unsigned/unattested | Medium | medium | sound |
| F2 | Container binary hardcoded `docker`; Podman unusable | Medium | medium | partial |
| G4 | Permission escalations are self-approvable | Medium | medium | sound |
| G5 | No spend/token budget (guardian can't see usage) | Medium | small | sound |
| G6 | Lone jailbreak phrase never escalates; tool output unscreened | Medium | small | sound |
| A2 | `setup.sh` "latest" resolver scrapes a redirect header | Low | trivial | sound |
| B5 | `automations check` shells `crontab` on Windows | Low | trivial | sound |
| E2 | Assistant image bakes no skeleton fallback floor | Low | small | sound (adjacent) |
| F1 | Rootless chown pass skipped on install path | Low | small | sound (adjacent) |
| G7 | Empty key file → 500 instead of 401 | Low | trivial | sound |

---

## 1. Security posture

### G1 — Agent can read every stack secret (Critical)
**Finding (confirmed).** `core.compose.yml:156` bind-mounts the whole `knowledge/` tree — including `knowledge/secrets/` — into the assistant at `/stash`. `opencode.jsonc:74` sets `bash "*":"allow"` and `:90` grants `external_directory "/stash/*":"allow"`. The container runs as the same UID that owns the `0600` secret files (`core.compose.yml:33`), so file mode gives no protection from the agent. Every delegated secret lives there (`portals.compose.yml:198-221`): guardian admin/MCP tokens, `op_api_key`, discord/slack bot tokens, portal principal secrets, opencode/UI passwords. One `cat /stash/secrets/*` (bash allow bypasses the external_directory gate) exfiltrates all of them. Combined with G3, any portal member can trigger it.

**Fix (verified, with required follow-through).** Shadow `/stash/secrets` with a dedicated assistant-only dir so delegated secrets become invisible to the agent, using the same nested-mount-wins pattern already used for `/opt/openpalm/tools` (`core.compose.yml:178-179`):
- `core.compose.yml`: after the `knowledge:/stash` line add `- ${OP_HOME}/data/assistant/secrets:/stash/secrets`.
- `home.ts` `ensureHomeDirs`: create `data/assistant/secrets` at `0700`.
- Delegated secrets stay in `knowledge/secrets` and still reach guardian/portals via the compose `secrets: file:` declarations — unaffected (guardian never mounts `/stash`, only `auth.json:ro`, verified `portals.compose.yml:158-175`).

**Audit-required completeness (why this is "partial"):** the assistant legitimately uses `/stash/secrets` for its **own** tool creds — `gws-setup.sh:189-193` writes `gcloud-credentials.json` there and the gws `SKILL.md:106-115` documents dropping creds into `knowledge/secrets`. So the fix must also (1) update the gws skill docs and the admin Secrets-tab guidance to the new host path (`data/assistant/secrets`), and (2) ship a one-shot upgrade migration moving existing `gcloud-credentials.json`/`.gws` from `knowledge/secrets` → `data/assistant/secrets`; otherwise gws breaks after upgrade. **Cleaner long-term alternative:** relocate the delegated-secret *source* files out of `knowledge/` entirely (e.g. `${OP_HOME}/private` 0700) and repoint every compose `secrets: file:` path — larger blast radius but removes secrets from the agent-visible tree at the source rather than shadowing.

**Residual (intrinsic).** The agent can still `cat ~/.local/share/opencode/auth.json` (its own provider keys, mounted separately at `core.compose.yml:154`); that exposure is inherent to OpenCode (agent and server share a UID) and cannot be removed without sandboxing the agent's bash from OpenCode, which OpenCode does not support. Scope the fix to the delegated secrets — the avoidable damage.

### G2 — Arbitrary shell is auto-approved (High)
**Finding (confirmed).** `opencode.jsonc:72-81` — `bash "*":"allow"`; only `rm -r*/-rf*`/`sudo *` escalate to "ask", only literal `rm -rf /` denies (last-match-wins, so the broad allow governs everything else). One global OpenCode server serves the UI, both portals, the API edge, and cron tasks — OpenCode's `permission` block is **server-global with no principal dimension**, so a low-trust portal user cannot be given a weaker shell than the local operator. The guardian has a per-principal lever (`decidePermission`) but it only fires on escalated `permission.asked` events, and blanket-allow means bash never escalates.

**Fix (verified).** Replace `"*":"allow"` with `"*":"ask"` **plus an allow-safelist** of read-only/known-safe commands, and `ask`/`deny` for exfil-prone verbs (`curl`, `wget`, `nc`, `base64`, `env`, `printenv`, `chmod`, and `cat`/`head` of secret-ish paths). A safelist (not a blanket "ask") is required because headless cron automations have nobody to answer prompts. Document that per-principal differentiation must live in the guardian (`decidePermission`), which becomes effective only once bash stops being blanket-allowed. **Caveat:** this is guardrails against accidents/low-effort injection, not a determined-agent sandbox; tune the safelist against the shipped skills/tasks so automation doesn't break.

### G3 — Portals are open by default (High)
**Finding (confirmed).** `portal-sdk/permissions.ts:66-72`: an empty allow-scope is skipped, and with all scopes empty it falls through to `allowed:true` (blocklist-only). `DISCORD_ALLOWED_*`/`SLACK_ALLOWED_*` default empty (`portals.compose.yml:25-28,66-68`). So any member of any guild/workspace the bot is in can drive it — and via G1/G2 that is enough to exfiltrate everything.

**Fix (verified).** Make portals default-deny: in each portal's `checkPermissions`, if **every** rule's allowedSet is empty, return `{allowed:false, reason:'no_allowlist_configured'}` and log a loud first-run WARN; optionally gate the setup wizard to require ≥1 allowed user when enabling a portal. The API edge uses a separate bearer check, so it is unaffected. **Audit note:** implement the test as "every rule's set is empty" (not by naming user/guild/role scopes) so a Slack channels-only allowlist is not misclassified. Ship with a release note — this is a behaviour change for anyone relying on the permissive default.

### G4 — Escalations are self-approvable (Medium)
**Finding (confirmed).** `discord/stream-render.ts:362-367` and `slack/stream-render.ts:178` gate the Approve/Deny buttons on `clicker === requestingUserId` (the message author). The person who prompts the assistant is exactly who is authorized to approve the resulting privilege escalation — no independent approver.

**Fix (verified).** Add `DISCORD_ALLOWED_APPROVERS`/`SLACK_ALLOWED_APPROVERS` (parseIdList), thread the Set through the existing `requestingUserId` plumbing, and change the **permission-ask** gate to `approvers.has(clicker)` (leave the model-facing `question` prompts gated on the requester). **Essential caveat:** with no approver configured, fail safe (deny escalations, or fall back to the allowlist owner) — never silently revert to self-approval, or the fix is a no-op. Couples to G3's default-deny posture.

### G5 — No spend/cost ceiling (Medium)
**Finding (confirmed).** `rate-limit.ts:7-12` counts requests only (120/min user, 200/min portal shared across all users, 600/min preauth) — no cost dimension. The guardian streams `/oc` responses **unparsed** (`proxy.ts:5-6,21`), so it cannot observe token usage; `OPENCODE_TIMEOUT_MS="0"` (`portals.compose.yml:101`) means an unbounded upstream turn.

**Fix (verified, honest scope).** A true token budget is **not feasible in the guardian** (it never parses responses) — say so plainly. Implement the nearest feasible controls: (1) lower `USER_RATE_LIMIT` and add a second longer-window (daily) per-user bucket — the rate-limit module already supports arbitrary keyed buckets with per-key `windowMs`; (2) set a **finite** `OPENCODE_TIMEOUT_MS` so one turn cannot run unbounded; (3) also arm a timeout on the API edge's non-streaming `forward()` path (it builds an AbortController but never arms it). Real cost budgeting requires token visibility that only OpenCode has — that would be an OpenCode-side plugin.

### G6 — Moderation gaps (Medium)
**Finding (confirmed).** Moderation runs only on inbound writes (`proxy.ts:374`, `mcp.ts:82`); responses/tool output are never screened (`proxy.ts:21`). In `content-screen.ts` several jailbreak phrasings are weight 2 while `ESCALATE_THRESHOLD=3` (`moderation.ts:47`), so a **single** weight-2 phrase (`"you are now"`, `"do anything now"`, `"pretend to be"`) scores 2 < 3 → allowed without LLM review. Multiple matches do sum and escalate.

**Fix (verified).** Raise the most unambiguous single-phrase jailbreak patterns from weight 2→3 in `content-screen.ts` (leave genuinely ambiguous ones like `"system prompt"`/`"act as"` at 2 to limit false positives). **Load-bearing caveat:** `DISCORD_SESSION_PREAMBLE` was reworded specifically to avoid tripping this screen and this code has regressed on first-turn preamble blocking before — validate any re-tune against the shipped preambles/skills. Tool-output screening is **out of the guardian's reach** (tool execution + context re-injection happen inside OpenCode) — state that explicitly; if wanted, it must be an OpenCode plugin.

### G7 — Empty key file → 500 (Low)
**Finding (confirmed).** `openai-api-secret-file.ts:29-32`: if `OPENAI_COMPAT_API_KEY_FILE` is *set* but the file is empty, it calls `readRequiredSecretFile` which **throws** `SecretFileError`. The auth check runs at `handleTurn:218`, outside the try/catch that starts at `:234`, so the throw surfaces as an opaque 500 instead of the documented fail-closed 401 (`portals.compose.yml:147`).

**Fix (verified, trivial).** In `openai-api.ts` `readCachedSecretFile`, wrap `readOptionalSecretFile` in try/catch: on `SecretFileError` return and cache `''`. An empty key then flows to `constantTimeEqual(token,'')` → false → clean 401. Collapses empty-file / missing-file / unset-env to the same fail-closed outcome; the `PRINCIPAL_SECRET_FILE` getter shares the path and benefits too.

---

## 2. Distribution & install

### A1 — `npm install -g openpalm` is broken (High)
**Finding (confirmed, reproduced live).** `packages/cli/package.json:15-19` `files=["bin","dist","README.md"]` (no `src`); `bin/openpalm.js:3` does `import { mainCommand } from '../src/main.ts'`; the tarball can't resolve it, and `src/main.ts` is a bun program (bun shebang, `.ts` imports, `@openpalm/lib`) that plain node can't run anyway. `release.yml:382-394` (npm-cli) publishes **without** `needs-build`, so no dist is produced. All `build:*` scripts use `bun build --compile` → standalone executables, not requirable modules.

**Fix (verified, with two audit-mandated corrections).** Convert the npm package into a **pure-node first-run bootstrapper**: `bin/openpalm.js` maps `platform+arch` → release binary (same table as `scripts/setup.sh:30-36`), downloads it from the GitHub release + verifies SHA-256 against `checksums-sha256.txt` (reusing the exact artifacts the curl installer uses), caches it, and `spawnSync`s it. Options "ship a node build" and "ship src + bun engine" are architecturally unviable (the CLI is bun/TS). **Corrections the audit caught, required or it breaks:** (1) `package.json:4` is `"type":"module"`, so `require('../package.json')` throws — use `createRequire(import.meta.url)` or `import pkg from '../package.json' with {type:'json'}`; (2) empty `dependencies[]` — the exact-pinned `@openpalm/skeleton` dep would make a global install fail if that version isn't on npm yet. Do the fetch on first **run**, not a postinstall hook (don't break `npm install` in CI). Windows-arm64 has no published binary → error clearly (ties to B4). **Fallback if a bootstrapper isn't wanted:** `npm deprecate openpalm` pointing at the curl/pwsh installer (trivial, abandons the npm UX).

### A2 — `setup.sh` "latest" resolver is brittle (Low)
**Finding (confirmed).** `scripts/setup.sh:73` scrapes the GitHub redirect `location:` header (`curl -sI | grep -i location`), reached only when `SCRIPT_VERSION=main`. `curl -sI` has no `-f`, so a non-redirect 200 yields empty, caught only by the downstream `|| die`.

**Fix (verified, sound).** Replace with the releases API: `curl -fsSL .../repos/itlackey/openpalm/releases/latest`, grep `"tag_name"`, pipe through the existing `normalize_version` (`setup.sh:22-24`). `-f` fails closed; jq avoided (matches the script's dependency-free style); prerelease semantics unchanged.

---

## 3. Windows

### B1 — No checksum verification on Windows (High)
**Finding (confirmed).** `scripts/setup.ps1:79-84` downloads the exe and `Move-Item`s it with **zero** integrity check, while `setup.sh:88-101` fetches `checksums-sha256.txt` and fails closed. `release.yml:876-880` (`sha256sum *`) does publish an entry for the Windows exe. A tampered/MITM'd asset installs silently on Windows.

**Fix (verified, sound).** Insert a fail-closed `Get-FileHash -Algorithm SHA256` block between download and `Move-Item`, mirroring `setup.sh`. `Get-FileHash` ships in PS 4.0+ (safe on 5.1 and 7). **Required:** compare case-insensitively — `Get-FileHash` returns UPPERCASE, `sha256sum` emits lowercase, else it rejects every download. `$ErrorActionPreference='Stop'` makes a `throw` abort before install.

### B2 — Windows PATH not persisted (Medium)
**Finding (confirmed).** `scripts/setup.ps1:86-87` only sets `$env:PATH` for the current process; no `SetEnvironmentVariable(...,'User')` anywhere. After the one-liner "succeeds," `openpalm` is not found in the next terminal.

**Fix (verified, with a registry gotcha).** Persist to User scope idempotently (no elevation needed). **Audit-caught risk:** the naive `[Environment]::GetEnvironmentVariable('Path','User')` → `SetEnvironmentVariable` round-trip **expands `REG_EXPAND_SZ` and writes back `REG_SZ`**, permanently baking out any `%USERPROFILE%`/`%JAVA_HOME%` tokens in the user's existing PATH. Read the **raw unexpanded** value via `Microsoft.Win32.Registry` `HKCU\Environment` with `RegistryValueOptions.DoNotExpandEnvironmentNames`, append `$InstallDir`, write back preserving the value kind. Dedup with split-and-contains. Keep the `$env:PATH` line for the current session.

### B3 — PowerShell 7+ hard-required (Medium)
**Finding (confirmed).** `scripts/setup.ps1:7-11` exits if `PSVersion.Major < 7`, refusing the 5.1 that ships on every stock Windows box. Auditing the script, the **only** genuinely PS6+ construct is `Invoke-WebRequest -MaximumRetryCount/-RetryIntervalSec` (`:82`); everything else is 5.1-compatible.

**Fix (verified, sound).** Drop the gate and replace the single retry-flag call with a manual `for` retry wrapper using `-UseBasicParsing` (required on 5.1 to avoid the IE-engine hang on Server Core). Apply the same wrapper to the B1 checksum fetch. `Get-FileHash`, `Start-Sleep`, try/catch all work on 5.1, so a full 5.1 path is achievable.

### B4 — No windows-arm64; self-update blocked on Windows (Medium)
**Finding (confirmed).** `release.yml:720-735` builds no windows-arm64; `setup.ps1:14` hardcodes `-x64.exe`; `self-update.ts:111-113` throws for all of win32. The name plumbing already exists (`resolveCliArtifactName` maps win32/arm64; `package.json:31` has `build:windows-arm64`).

**Fix (verified, sound — with a gating unknown).** Add a windows-arm64 matrix entry and make `setup.ps1` arch-aware (`$env:PROCESSOR_ARCHITECTURE`). **Crucial caveat:** the existence of the build script does **not** prove Bun can `--compile` `bun-windows-arm64` in this era — cross-compiling that target is unverified and may fail in CI. Validate by actually running the job; if Bun can't produce it, the interim fix is a clear "arm64 not yet available, use x64 under emulation" message rather than a 404 download URL. The in-use-file self-update replacement is genuinely harder on Windows (`schedulePosixReplacement` uses `mv` over a running file, which Windows disallows) and is a separate effort from the arch fix.

### B5 — `crontab` shelled unconditionally (Low)
**Finding (confirmed).** `commands/automations.ts:29-45` runs `execFile('crontab',['-l'])` with no platform guard; on Windows it ENOENTs and prints the misleading "No crontab found — assistant not started?"

**Fix (verified, trivial).** Add a `process.platform==='win32'` guard printing a platform-appropriate message before the `execFile` block; `process` is already in scope. The task-directory listing above stays.

### B6 — Secret perms are a no-op on Windows (Medium)
**Finding (confirmed).** `secrets-files.ts` hardens only via POSIX `chmod 0600/0700` (`:7-8,23-26,44-46`); on win32 Node's chmod only toggles read-only and does not restrict other-user access. No `icacls`/ACL anywhere. On shared Windows hosts, secrets inherit the parent dir's ACL.

**Fix (verified, with a perf gotcha).** On win32, add `icacls` hardening (`/inheritance:r /grant:r "<user>:F"`) alongside the existing chmod, wrapped in try/catch (non-fatal on FAT/exFAT). **Audit-caught problem:** `resolveSecretsDir` is the **read + write** choke point, so an unconditional `icacls` spawn there fires on every secret *read*. Gate it to run only when the dir was newly created (capture the `mkdirSync` result or memoize a per-process "already hardened" set); rely on `(OI)(CI)` inheritance for files rather than per-file spawns. Prefer resolving the current-user SID over env-var `USERNAME` for robustness. This improves on-disk protection but isn't OS-keychain storage — secrets remain plaintext on disk; document that.

---

## 4. Lifecycle / CLI gaps

### C1 — `uninstall --purge` doesn't purge, then blocks reinstall (High)
**Finding (confirmed).** `commands/uninstall.ts:44` purges `[config, stash, workspace, data]` only — not `resolveStateDir()` or `resolveSystemDir()` (both exist, `home.ts:55-62`, and are exported, `index.ts:92-93`). Survivors: `state/stack.env` (with `OP_SETUP_COMPLETE`) trips `hasAnyStackEnvFile` and `system/stack/core.compose.yml` trips `hasMaterializedLocalInstall`, so the next plain `openpalm install` throws "already installed" — contradicting the purge's own "all data removed" message.

**Fix (verified, sound).** Add `resolveSystemDir()` and `resolveStateDir()` to the dirs list, ordered **before** `resolveDataDir()` so the lock-owning `data/` is removed last (the `purgeRemovedLock` guard at `:48` still fires on the final iteration). `state/`/`system/` hold no lock or in-use handle. Wiping `schema-version`/`host-identity.json` is correct — `install` re-creates them via `ensureHomeDirs`.

### C2 — No CLI `doctor` (Medium)
**Finding (confirmed).** The full docker/compose/port/GPU/runtime preflight lives only in the SvelteKit route `api/setup/system-check/+server.ts` — which won't render if Docker or the UI port is the problem. No `doctor`/`diagnose` in the CLI. The building blocks *are* in `@openpalm/lib` and CLI-reachable (`checkDocker`, `checkDockerCompose`, `detectRuntime`, `detectGpu`, `detectLocalProviders`); only the TCP port probe + `portHeldByOurContainer` are trapped inline in the UI route.

**Fix (verified, with one refinement).** Add `openpalm doctor` composing the exported lib checks + a small `node:net` port probe, registered via one `subCommands` key. **Audit refinement:** `portHeldByOurContainer` is **not** optional — a plain `checkPortAvailable` (127.0.0.1 bind test) run while the stack is **up** flags all three ports (3880/3800/3810) as conflicts, a false positive for exactly the operator whose stack is running. Fold in the docker-ownership check (or clearly label "in use — possibly by OpenPalm itself"). Mirror the wizard's port fallbacks.

### C3 — Lost UI password = lockout (High)
**Finding (confirmed).** One shared password (`session-store.ts:52-56`); no forgot-password flow; `unlock` only clears the install lock. Recovery today requires hand-editing `knowledge/secrets/op_ui_login_password` and restarting.

**Fix (verified, with a restart caveat).** Add `openpalm reset-password` that writes a new value via the existing `patchSecretsEnvFile`/`writeSecret` (`op_ui_login_password`) and **restarts the UI-serving container**. Session invalidation is automatic — `sessionSigningKey = HMAC(serverKey, sha256(password))` (`session-store.ts:93-95`), so rotating the password fails every outstanding cookie with no extra logout code. **Restart is mandatory, not cosmetic:** `getUiLoginPassword` reads the env var first (`:53`) and the running UI baked the old password into its process env at start, shadowing a file-only rewrite until restart. **Audit note:** the entrypoint's `*_FILE`→env conversion could not be verified from source (the assistant entrypoint is baked into the published image, not in this repo) — the container-served UI re-reads the compose file-secret on restart, but the CLI can't restart a *host-side* `openpalm ui`/Electron process, so the command should instruct the operator to restart that one.

---

## 5. Docker error UX

### D1 — Day-2 lifecycle errors are blank/raw (High)
**Finding (confirmed, full call graph traced).** The friendly three-stage `requireDocker` is private in `commands/install.ts:123-127` and called **only** from install/update/wizard. `start`/`stop`/`restart`/`rollback`/`addon enable` all route through `runComposeWithPreflight` → `buildComposePreflightError`, which interpolates raw stderr; when the docker binary is missing, `toDockerResult` yields **empty** stderr (`docker.ts:35-50`), so the user sees `Compose preflight failed:` + a blank line. `mapDockerError` (the friendly classifier) is wired only into `applyStack`, and its regexes match neither empty/ENOENT nor the typical permission-denied wording. Also: `docker compose config --quiet` never contacts the daemon, so a **stopped** daemon passes preflight and fails later with a generic "exit code N".

**Fix (verified, sound, non-breaking).** Three parts: (1) add `not-installed` (ENOENT/`command not found`) and `permission-denied` branches to `mapDockerError` reusing the `docker_unavailable` code (callers read only `.message`, so no enum change); (2) add an exported `ensureDockerReady()` helper in lib (`checkDocker` + `checkDockerCompose` → friendly message) and propagate `errorCode` from `checkDocker`; (3) call it as a preamble in `runComposeWithPreflight`, gated by the existing `OP_SKIP_COMPOSE_PREFLIGHT` env so current tests stay green (verified: `start.test.ts`/`rollback.test.ts` fully mock the function; `route-canonical-helpers.test.ts` asserts individual fields so adding `errorCode` is safe; the name `ensureDockerReady` is only forbidden in electron main by a hygiene test, untouched here). The preamble also catches the **stopped-daemon** case that preflight misses. **Refinements:** `checkDocker` uses an unbounded timeout — a *hung* daemon would make the preamble hang; add a bounded probe. With the preamble in place, the part-3b ENOENT handling is belt-and-suspenders.

---

## 6. Supply chain & versioning

### E1 — Images default to moving `:latest` (Medium)
**Finding (confirmed).** `versions.ts:36-41` defaults all `OP_*_VERSION` to `"latest"`; `setup.ts:395` rewrites a blank Advanced tag back to `"latest"` on **every** setup run. Only an explicit `--version` pins; the wizard never threads a version. Two installs from the same CLI can run different, unrecorded images.

**Fix (verified, with corrections).** Pin assistant/guardian/portal defaults to the CLI's own `PLATFORM_VERSION` in `setup.ts` (not a blanket `VERSION_DEFAULTS` change — that would break the wizard/file split), keeping `"latest"` as an explicit opt-in. **Corrections the audit caught:** (a) **exclude voice** — its tags are `latest-cpu`/`vX.Y.Z-cu121`, not platform semver, so a semver pin yields a nonexistent `openpalm/voice:0.13.0`; (b) guard the pin behind an image-existence check because a host-only release (`unit=platform`, no images) publishes no matching tag and would strand the install on a 404 — `dockerManifestExists` can do this **but is currently private** (`addon-availability.ts:90`) and must be exported, and the check must honor `OP_IMAGE_NAMESPACE` (don't hardcode `openpalm/…`). The channel/`next` logic is orthogonal (governs UI self-update only), so image defaults don't affect it.

### E2 — Assistant image bakes no skeleton floor (Low, corrected)
**Finding (corrected — see top).** The stack does **not** brick offline. Real gap: unlike the guardian (`guardian/Dockerfile:71`), the assistant Dockerfile bakes no `@openpalm/skeleton` fallback (`:173` only `mkdir`s the dir), so an air-gapped *first* boot on a fresh volume has nothing for the entrypoint's soft-continue to fall back to.

**Fix (verified, sound).** Mirror the existing `@openpalm/ui` bake in `containers/assistant/Dockerfile:191-197`: a `PLATFORM_VERSION`-gated `npm install --prefix /opt/openpalm/skeleton @openpalm/skeleton@$PLATFORM_VERSION`. The `assistant-artifacts` named volume seeds from the image path on first creation (same mechanism guardian relies on), so the baked floor survives into the runtime volume; every online boot still upgrades it in place. The release preflight already asserts the version is published, so the bake can't 404.

### E3 — Voice published out-of-band; silent drift (Medium)
**Finding (confirmed).** `publish-voice.yml` is `workflow_dispatch`-only; `release.yml` has no `include_voice` and its header states voice is the one thing `all` doesn't build. `voiceImageRef` defaults to the moving `latest-<variant>` tag; no runtime compat assertion exists. (assistant-models is a weaker instance — pinned at **build** time via `ARG`, so it only drifts on an explicit Dockerfile bump.)

**Fix (verified, sound).** Two mitigations that cover **different** windows — not interchangeable: (1) DAG tie-in — add `include_voice` + a `docker-voice` job (or make `publish-voice.yml` a `workflow_call`) so a release also stamps `openpalm/voice:<version>-<variant>`; keep it opt-in because voice images are heavy and cu121 is amd64-only. This only helps **future** installs. (2) For the large population of **existing** installs pulling the moving `latest-*` tag, add a runtime `VOICE_CONTRACT` label the voice probe asserts against a platform-side expected value, surfacing a warning (not a hard block) on mismatch. `release.yml` already has the needed permissions; `publish-voice.yml` would need `id-token: write` if signed.

### E4 — Images unsigned/unattested (Medium)
**Finding (confirmed).** `release.yml` sets `provenance:false, sbom:false` for portal/guardian/assistant (`:516,580,703`); `publish-voice.yml`/`publish-assistant-models.yml` push unsigned. No cosign/attest anywhere. A registry compromise or tag overwrite is undetectable.

**Fix (verified — free, in-scope).** Add cosign **keyless** signing (GitHub OIDC + Fulcio/Rekor, no secret). Give each build-push step `id: build`, add `sigstore/cosign-installer@v3`, then `cosign sign --yes <image>@${{ steps.build.outputs.digest }}`. **`release.yml` needs zero permission changes** — `id-token: write` is already present (`:98`). Only `publish-voice.yml`/`publish-assistant-models.yml` need `id-token: write` added. Cosign signatures are a few-KB OCI artifact, so they don't trigger the Docker Hub multi-blob CDN 400 that forced `provenance/sbom` off — those can stay off. Don't sign dry-run builds (they don't push). Document the verify command (`cosign verify --certificate-identity <repo OIDC identity> --certificate-oidc-issuer https://token.actions.githubusercontent.com`). Optionally re-enable SBOM/provenance on a parallel GHCR push (GHCR lacks the CDN bug).

---

## 7. Cross-runtime

### F1 — Rootless chown pass skipped on install (Low, corrected)
**Finding (corrected — see top).** Core services **are** protected under rootless via a `docker run alpine chown` reconcile + arbitrary-uid Dockerfiles. Do **not** generalize voice's drop-`user:` overlay — it would regress the design and break the `guardian-rootless`/`portal-rootless` guardrail tests. Real residual: `reconcileHostOwnership` is wired into `start`/`upgrade`/`up` but **not** `applyInstall`, so a one-shot fresh rootless install's first `up` can hit unwritable operator-owned bind dirs before any chown.

**Fix (verified, sound).** Call the existing `reconcileHostOwnership(state, { services: await buildManagedServices(state) })` inside `applyInstall` (`lifecycle.ts:243-246`), mirroring `performUpgrade` (`:280`) — both helpers are already imported there, so it's a one-line addition. The UI install route calls `applyInstall` before its own `applyStack`, so editing `applyInstall` alone suffices. Document the inherent rootless tradeoff (chown moves bind-dir ownership to the sub-uid range, so the host operator can no longer directly edit those files — already true on the start path). **Cross-link:** under Podman the chown mitigation itself breaks because it shells hardcoded `docker` (see F2).

### F2 — Hardcoded `docker` binary; Podman unusable (Medium)
**Finding (confirmed).** `"docker"` is hardcoded at every exec site (`docker.ts:92,419,484`, plus `voice-host-probes.ts`, `addon-availability.ts`, `launch-status.ts`, and several UI routes). Podman is only string-detected for the *display* label (`launch-status.ts:47-52`) — nothing switches the binary. On a Podman-only host every op ENOENTs while the UI cheerfully labels the runtime "Podman."

**Fix (verified — necessary but not sufficient).** Add `dockerBin()` (`OP_DOCKER_BIN` || `"docker"`) in `docker.ts` and route all exec sites through it (argv is already array-based, so only the program name changes; `docker.ts`'s shared `run` collapses most paths to three edits). **The audit is emphatic this seam alone doesn't deliver the "works on Podman" impact:** (1) `docker compose` needs Podman's Docker-compatible compose provider (podman ≥4.x); python `podman-compose` diverges on `--wait`/`--profile`/`--progress`; (2) `host.docker.internal:host-gateway` needs podman ≥4.7 (podman natively provides `host.containers.internal`); (3) `detectRootlessDocker` needs a podman branch (podman is rootless by default) — and this is load-bearing for F1, since both the rootless detection and the core-service chown mitigation depend on the binary resolving. Add a `<bin> compose version` preflight that surfaces a clear error when the provider is missing. Ship the seam as step one; full Podman support is medium effort beyond it.

---

## Suggested implementation order
1. **G1** (critical, secret exfiltration) — plus its gws doc/migration follow-through.
2. **C1, D1, C3, B1** — high-impact, small/trivial, no behaviour-change risk (purge, day-2 errors, password reset, Windows checksum).
3. **A1** — restore/repair the npm channel (or deprecate it deliberately).
4. **G3 + G4 + G2** — close the portal trust gaps together (default-deny, approver, bash safelist); ship with a release note.
5. **E4** — free cosign signing, near-zero-risk supply-chain win.
6. **B2, B3, B5, G6, G7** — small Windows/moderation/edge hardening.
7. **E1, E2, E3, F1, C2, B6** — versioning/air-gap/rootless/doctor/ACL correctness.
8. **F2, B4, G5** — larger cross-runtime / arm64 / cost-control efforts with the noted unknowns (Bun arm64 target; Podman compose provider; token visibility).

---

## Method & confidence notes

- **Discovery** was performed by five parallel read-only exploration agents (CLI install seams, the compose stack, UI/Electron surfaces, distribution/release, portal+guardian security), each instructed to ignore documentation and cite file:line evidence.
- **Verification** of each finding and its recommended fix was performed by a second, structured pass: per-domain design + an independent adversarial audit that re-opened the files to confirm the finding held and the fix was correct, complete, and non-breaking. The "Fix verdict" column and the audit notes inline reflect that second pass.
- **Corrections:** the two items marked "corrected" (E2, F1) were overstated in the first pass and downgraded after verification — both turned out to be designed-but-incomplete mitigations rather than outright failures. The other 23 held up under adversarial re-verification.
- This report is **point-in-time** against `a73a6b4`. Line numbers will drift as the code changes; treat the file:function citations as the durable anchor.
