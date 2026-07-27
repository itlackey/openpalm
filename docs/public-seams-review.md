# OpenPalm Public-Seams Review — Findings & Recommended Fixes

**Date:** 2026-07-26
**Reviewed at:** `main` @ `a73a6b4` · package version `0.13.0-beta.13`
**Scope:** the public seams a real user touches — CLI install/lifecycle, the Docker Compose stack, the web/Electron admin surfaces, distribution/release packaging, and the Discord/Slack portal + guardian message path.

## About this review

This is a **point-in-time, documentation-blind audit**. Every finding was derived **only** from the implemented code and configuration — README/CHANGELOG/`.env.example` claims were deliberately ignored, and are noted only where they *contradict* the code. Each finding was confirmed by reading the implementation (file:line evidence below). Each recommended fix was then checked against the real code for feasibility (that the exports/functions it relies on exist, the exact edit sites, and that it doesn't break existing tests or behaviour), and independently adversarially audited.

**Constraint acknowledged:** desktop-app **code-signing is an accepted limitation** (the project cannot afford signing/notarization fees). No paid signing is recommended anywhere in this report. Note that Docker **image** signing via cosign *keyless* (GitHub OIDC + Sigstore) is free and is therefore recommended where relevant (finding E4) — it is not covered by the code-signing exclusion.

**Verification outcome:** 25 findings — 23 confirmed as originally stated, **2 corrected** during deeper verification (headline overstated; a narrower real gap remains). The corrections are called out explicitly below, because they matter for calibrating confidence in the rest.

**Design-intent revision (this version).** After a maintainer review, several findings were re-scoped to match the system's *intended* design rather than a generic hardening posture. In particular: the assistant is deliberately lax (friction-free for non-technical users) and is meant to be safe because of what sits *in front of* it (the guardian and network restrictions) — so the recommendation is to fix the **secret-exposure source** (G1), not to lock down the assistant's shell (G2). One finding (G4, self-approval) is **withdrawn as intended behaviour**, and one (B6, Windows secret ACLs) is **accepted as a known Windows limitation**. Two recommendations (C3 password reset, E2 runtime installs) were re-pointed at the underlying design flaw instead of a workaround.

**Tracked-issue integration (this version).** This revision also folds in two open 0.13.0 issues, keeping their fixes consistent with the recommendations above: **[#581 Reduce Container Storage Growth](https://github.com/itlackey/openpalm/issues/581)** — a detailed maintainer root-cause review of a real production disk-exhaustion incident ("krang") that strongly validates and extends **E2**, added as **Section 8** (findings S1–S8); and **[#577 Code-review follow-ups from #574](https://github.com/itlackey/openpalm/issues/577)** — two UI code-quality items, added as **Section 9** (U1–U2). Where an issue's fix overlaps an existing finding it is cross-referenced rather than duplicated (E2 ⟷ deterministic installs; C2 ⟷ `openpalm storage report`; E1 ⟷ image/volume retention), and where an issue's concern is **already fixed in current code** (the full-`data/` backup defect) the recommendation is scoped to what remains.

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
| G1 | Delegated secrets + env:user reachable by the assistant agent (bash `env`/`cat`) | **Critical** | medium | re-scoped to design intent |
| A1 | `npm install -g openpalm` is broken | High | medium | needs-refinement |
| B1 | Windows installer has no checksum verification | High | small | sound |
| C1 | `uninstall --purge` leaves `state/`+`system/`, blocks reinstall | High | trivial | sound |
| C3 | Lost UI password = lockout; password change needs a restart (design flaw) | High | small | re-scoped to root cause |
| D1 | Day-2 `start/stop/…` show blank/raw Docker errors | High | small | sound |
| G2 | Assistant shell is lax by design; denylist must actually match, guardian must stay locked down | High | medium | re-scoped to design intent |
| G3 | Portals default-open (empty allowlist = unrestricted) | High | small | sound (+ `*` opt-in) |
| B2 | Windows PATH not persisted | Medium | small | partial (registry gotcha) |
| B3 | PowerShell 7+ hard-required on stock Windows | Medium | small | sound |
| B4 | No windows-arm64 build; self-update blocked on Windows | Medium | medium | sound |
| C2 | No CLI `doctor`; preflight only in the browser wizard | Medium | medium | partial |
| E1 | Image tags default to moving `:latest` | Medium | medium | partial |
| E2 | Assistant/guardian install & self-update packages at runtime (drift, non-reproducibility) | Medium | medium | re-scoped: bake into image |
| E4 | All images unsigned/unattested | Medium | medium | sound |
| F2 | Container binary hardcoded `docker`; Podman unusable | Medium | medium | partial |
| G5 | No spend/token budget (guardian can't see usage) | Medium | small | sound (+ future plugin) |
| G6 | Lone jailbreak phrase never escalates; tool output unscreened | Medium | small | sound (+ future plugin) |
| A2 | `setup.sh` "latest" resolver scrapes a redirect header | Low | trivial | sound |
| B5 | `automations check` shells `crontab` on Windows | Low | trivial | sound |
| E3 | Voice image published out-of-band; silent drift | Low | small | sound (kept minimal) |
| F1 | Rootless chown pass skipped on install path | Low | small | sound (adjacent) |
| G7 | Empty key file → 500 instead of 401 | Low | trivial | sound |
| S1 | Regenerable caches/artifacts written into durable `data/` (#581) | **Critical** | medium | new |
| S2 | Tool tree stored 3× + boot-time `bun update` (#581) | **Critical** | medium | fixed by E2 |
| S3 | OpenCode SQLite DB unbounded; no retention/`VACUUM` (#581) | **Critical** | large | new |
| S4 | Portal session reuse dead; guardian eviction orphans sessions (#581) | High | medium | new |
| S5 | Backup lifecycle defects — placement/atomicity/prune (#581) | High | medium | core already fixed |
| S6 | Disk-pressure restart/install feedback loop (#581) | High | small | mostly via E2/S1 |
| S7 | Docker image/volume retention; orphan rename volumes (#581) | Medium | medium | complements E1 |
| S8 | No storage diagnostics/thresholds (#581) | Medium | medium | folded into C2 |
| U1 | Activation veto via fragile `=== false` return (#577) | Low | small | new |
| U2 | Redundant IndexedDB `getAll()` probe (#577) | Low | trivial | new |
| G4 | Permission escalations approvable by requester | — | — | **By design — withdrawn** |
| B6 | Secret file perms are a no-op on Windows (no ACL) | — | — | **Accepted limitation (Windows)** |

---

## 1. Security posture

### G1 — Delegated secrets and env:user are reachable by the assistant agent (Critical)

**Intended design.** The assistant is *supposed* to store and load secrets in its akm stash and use akm (a trusted tool) to load values on demand **without exposing them to the model's context**, with OpenCode permissions preventing the agent from reading the secret/env files directly. That intent is sound. The problem is that the current implementation does not actually deliver it, and it additionally co-locates *other services'* secrets in the same agent-reachable tree. This finding is re-scoped to **support that intent and fix the parts of the current design that defeat it** — not to lock down the assistant's shell (see G2).

**Finding (confirmed).** Three independent facts, all verified in-repo, mean the agent can trivially obtain secrets the design intends to hide:

1. **The whole `knowledge/` tree — including `knowledge/secrets/` — is bind-mounted into the assistant at `/stash`** (`core.compose.yml:156`), and `external_directory "/stash/*":"allow"` (`opencode.jsonc:90`) allows it wholesale. That tree contains **delegated secrets the assistant never needs** — guardian admin/MCP tokens, `op_api_key`, discord/slack bot tokens, portal principal secrets, opencode/UI passwords (`portals.compose.yml:198-221`) — which are consumed only by the guardian and portals.
2. **OpenCode permissions cannot stop the direct read**, and the repo's own comments say so: the `read` dimension's resource keys are matched **relative to the worktree** (`/work`), so an absolute-path deny like `/stash/secrets/*` matches nothing (`opencode.jsonc:68-71`, `guardian/opencode.jsonc:28-30`); there is no `read` block at all for the assistant (`:84-86`); and `bash "*":"allow"` bypasses the `read` dimension entirely. The config itself states "guardrails against accidents, not against a determined agent" (`:64`).
3. **The env:user secrets are `source`d directly into the OpenCode server's own process environment.** `entrypoint.sh:51-61` (`maybe_source_akm_user_env`) does `set -a; . "$AKM_STASH_DIR/env/user.env"`, and `start_opencode` then `exec`s `opencode` from that same shell — so every value is an environment variable of the server and of every `bash`-tool subprocess. The agent gets them with `env` / `printenv` / `$KEY`, touching no file path at all. A path denylist is powerless here.

Net: a single lax bash call (`env`, or `cat /stash/secrets/*`) exfiltrates every delegated secret and every user env value. Combined with G3, any portal member can trigger it. A denylist **cannot** close this (see G2's note on pattern-matching fragility).

**Fix (supports the intent — fix the source, not the shell).** Three changes, in priority order:

1. **Get the delegated secrets out of the assistant's stash entirely.** They belong to the guardian/portals, which already receive them via compose `secrets: file:` — the assistant has no reason to see them. Relocate the *source* files from `knowledge/secrets/` to a non-stash directory (e.g. `${OP_HOME}/private/secrets`, `0700`), repoint the compose `secrets: file:` paths (`portals.compose.yml:196-221`, `core.compose.yml:260-268`) and the `home.ts`/`secrets.ts` writers, and add a one-shot migration. Result: they are delivered only to the containers that need them, and never appear under `/stash`. This is the single highest-value change and it does not touch the assistant's own akm secrets.
2. **Stop exporting the akm env:user / secret values into the OpenCode server's process environment.** Change `entrypoint.sh`'s `maybe_source_akm_user_env` so `env:user` is loaded **on demand inside a narrowly-scoped subprocess** (the way `load_vault`/`akm_env` are meant to work — `core.md:44-45`) rather than sourced into the top-level server via `set -a; exec opencode`. This is what actually makes "akm loads it, but the agent can't dump it with `env`" true. (Entrypoint is baked into the image, so this ships in a new assistant image — see E2.)
3. **Keep the assistant's *own* akm secrets (gws/gcloud creds, the user env namespace) in the stash, but reached only through akm.** With (1) and (2) done, the only secret-shaped material left under `/stash` is the assistant's own, and the akm tools (`akm_secret`/`akm_env`) are the intended access path. Note the residual honestly (below) — this raises the bar substantially but is not a hard sandbox.

**Guardian side (ties to G2).** The guardian is already correctly constrained — it mounts **only** `knowledge/secrets/auth.json:ro` (`portals.compose.yml:175`), no `/stash`, and its OpenCode session has `bash/edit/webfetch: deny` (`guardian/opencode.jsonc:24-27`). The one deviation from "guardian receives secrets only through the compose entry" is that `auth.json` arrives as a **bind mount from `knowledge/`** rather than a compose `secrets:` entry. Deliver it as a compose secret and have the entrypoint place it where OpenCode reads it, so the guardian mounts **nothing** from `knowledge/`.

**Residual (intrinsic, and acceptable per the threat model).** Even after this, the agent can read OpenCode's own `auth.json` (its provider keys, mounted at `core.compose.yml:154`), because the agent and the OpenCode server share a UID and the server must read that file — OpenCode offers no way to sandbox the agent's bash from it. That exposure is intrinsic; the point of this fix is to remove the **avoidable** blast radius (other services' secrets and the user env values), which is large and unnecessary. The residual is consistent with the intended model where the assistant is trusted and the guardian/network form the real boundary.

### G2 — Assistant shell is lax by design; make the denylist real and keep the guardian locked down (High)

**Intended design (accepted).** The assistant *should* have fairly lax default permissions to avoid friction for non-technical users; requests reaching it are expected to be safe because of the constraints **in front of** it (the guardian and network restrictions). So the rule is intentionally asymmetric: **the assistant allows all but known-bad commands; the guardian denies all but an explicit minimum.** The earlier recommendation to switch the assistant to an allow-safelist is **withdrawn** — it contradicts that intent. The recommendation below keeps the assistant lax but removes the two things that make "lax" dangerous.

**Finding (confirmed).** `opencode.jsonc:72-81` — `bash "*":"allow"`; only `rm -r*/-rf*`/`sudo *` escalate to "ask", only literal `rm -rf /` denies (last-match-wins). This posture is fine **only if** (a) the denylist actually matches real invocations, and (b) a lax shell can't reach anything catastrophic. Both are currently violated: the config documents that a prior `"sudo *"` rule compiled to `^sudo$` — matching only bare `sudo` (`opencode.jsonc:68-69`) — so the "ask"/"deny" patterns silently fail to match realistic commands; and per G1 a lax shell can read every stack secret. The guardian, by contrast, is correctly the constrained tier (`bash/edit/webfetch: deny`, `guardian/opencode.jsonc:24-27`).

**Fix (aligned to intent).**
1. **Keep the assistant default-allow**, but **repair the denylist so it actually matches.** Audit every `bash` "ask"/"deny" pattern against OpenCode's matcher (the `^sudo$` bug shows patterns need explicit globbing, e.g. `sudo *` / `sudo*` / `* sudo *` as the matcher requires) so `sudo`, `rm -rf`, and any known-bad/destructive verbs genuinely escalate or deny. This is guardrails against accidents and low-effort injection — explicitly *not* a determined-agent sandbox, which is the accepted trade-off for a friction-free assistant.
2. **The real safety of a lax assistant depends on G1**, not on the shell policy: once the delegated secrets are out of the stash and env:user is no longer exported into the server process, "lax bash" no longer means "read every secret." Treat G1 as the load-bearing control here.
3. **Keep the guardian highly constrained** (it already is) and complete it per G1's guardian note: deliver `auth.json` via a compose secret so the guardian mounts nothing from `knowledge/`, and keep its tools/webfetch denied. The guardian — not the assistant — is where request-level constraint belongs.

**Note on per-principal policy.** OpenCode's `permission` block is server-global (one assistant serves UI, portals, API, cron), with no principal dimension, so a portal user cannot be given a different shell than the local operator. That is acceptable under the intended model (constraint lives in the guardian in front, not in per-principal assistant policy); the guardian's `decidePermission` lever is the place to add principal-aware limits if ever needed, and it only becomes relevant for the narrow set of commands that escalate to "ask."

### G3 — Portals are open by default (High)
**Finding (confirmed).** `portal-sdk/permissions.ts:66-72`: an empty allow-scope is skipped, and with all scopes empty it falls through to `allowed:true` (blocklist-only). `DISCORD_ALLOWED_*`/`SLACK_ALLOWED_*` default empty (`portals.compose.yml:25-28,66-68`). So any member of any guild/workspace the bot is in can drive it — and via G1/G2 that is enough to exfiltrate everything.

**Fix (verified, with an explicit opt-in).** Make portals default-deny: in each portal's `checkPermissions`, if **every** rule's allowedSet is empty, return `{allowed:false, reason:'no_allowlist_configured'}` and log a loud first-run WARN; optionally gate the setup wizard to require ≥1 allowed user when enabling a portal. The API edge uses a separate bearer check, so it is unaffected. **Audit note:** implement the test as "every rule's set is empty" (not by naming user/guild/role scopes) so a Slack channels-only allowlist is not misclassified.

**Preserve the current behaviour as an explicit opt-in.** Add support for `"*"` as an allow-all sentinel in the relevant allowlist settings (e.g. `DISCORD_ALLOWED_USERS="*"`), so an operator who genuinely wants "any member" can enable it deliberately. `parseIdList` (`runtime.ts:103`) currently just comma-splits into a Set, so this is a small change: keep `"*"` as a member and, in `checkPermissions`, treat a scope whose set contains `"*"` as unrestricted-for-that-scope. This turns today's silent, implicit allow-all into an explicit, documented choice. Ship the default-deny flip with a release note — it is a behaviour change for anyone relying on the permissive default.

### G4 — Escalations are approvable by the requester — *By design (withdrawn)*
**Status: not a defect.** The original finding proposed a separate approver so that a user could not approve their own privilege escalation. Per maintainer intent this is **working as designed**: the agent is requesting a permission and the requesting user is the one approving it — a second-party approver is explicitly *not* wanted. `discord/stream-render.ts:362-367` and `slack/stream-render.ts:178` gate the Approve/Deny buttons on `clicker === requestingUserId` deliberately. No change recommended; retained here only to record that it was considered and intentionally kept. (Access control over *who can talk to the bot at all* is handled by G3.)

### G5 — No spend/cost ceiling (Medium)
**Finding (confirmed).** `rate-limit.ts:7-12` counts requests only (120/min user, 200/min portal shared across all users, 600/min preauth) — no cost dimension. The guardian streams `/oc` responses **unparsed** (`proxy.ts:5-6,21`), so it cannot observe token usage; `OPENCODE_TIMEOUT_MS="0"` (`portals.compose.yml:101`) means an unbounded upstream turn.

**Fix (verified, honest scope).** A true token budget is **not feasible in the guardian as it stands** (it never parses responses) — say so plainly. Implement the nearest feasible interim controls: (1) lower `USER_RATE_LIMIT` and add a second longer-window (daily) per-user bucket — the rate-limit module already supports arbitrary keyed buckets with per-key `windowMs`; (2) set a **finite** `OPENCODE_TIMEOUT_MS` so one turn cannot run unbounded; (3) also arm a timeout on the API edge's non-streaming `forward()` path (it builds an AbortController but never arms it).

**Future (recommended proper fix): a dedicated OpenCode plugin for the guardian.** Real cost budgeting requires token/usage visibility that only OpenCode has. A future update should build a first-class **guardian OpenCode plugin** that observes turn usage (tokens/cost) at the source and enforces per-principal spend budgets — the correct long-term home for this control, and shared with G6.

### G6 — Moderation gaps (Medium)
**Finding (confirmed).** Moderation runs only on inbound writes (`proxy.ts:374`, `mcp.ts:82`); responses/tool output are never screened (`proxy.ts:21`). In `content-screen.ts` several jailbreak phrasings are weight 2 while `ESCALATE_THRESHOLD=3` (`moderation.ts:47`), so a **single** weight-2 phrase (`"you are now"`, `"do anything now"`, `"pretend to be"`) scores 2 < 3 → allowed without LLM review. Multiple matches do sum and escalate.

**Fix (verified).** Raise the most unambiguous single-phrase jailbreak patterns from weight 2→3 in `content-screen.ts` (leave genuinely ambiguous ones like `"system prompt"`/`"act as"` at 2 to limit false positives). **Load-bearing caveat:** `DISCORD_SESSION_PREAMBLE` was reworded specifically to avoid tripping this screen and this code has regressed on first-turn preamble blocking before — validate any re-tune against the shipped preambles/skills.

**Future (recommended proper fix): the same dedicated guardian OpenCode plugin (see G5).** Tool-output / retrieved-content injection — the more dangerous vector — is **out of the guardian's reach today**, because tool execution and context re-injection happen inside OpenCode and the guardian streams responses unparsed. The correct long-term fix is a **guardian OpenCode plugin** that can screen tool output and re-injected context at the source. Note that plugin as a single future work item covering both G5 (spend visibility) and G6 (tool-output screening).

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

### B6 — Secret perms are a no-op on Windows — *Accepted limitation*
**Status: known limitation, not scheduled for a fix.** `secrets-files.ts` hardens only via POSIX `chmod 0600/0700` (`:7-8,23-26,44-46`); on win32 Node's chmod only toggles the read-only bit and does not restrict other-user access, and there is no `icacls`/ACL fallback — so on a shared Windows host the secret files inherit the parent directory's ACL. Per maintainer decision this is **accepted as a known Windows limitation** and deferred. Documented here so it is a recorded, deliberate choice rather than an oversight. (If it is ever revisited, the approach would be win32 `icacls` hardening gated to directory-creation only — see the change history — but no work is planned.) Operators on shared/multi-user Windows machines should be aware that OpenPalm secrets are not OS-enforced-private on that platform.

---

## 4. Lifecycle / CLI gaps

### C1 — `uninstall --purge` doesn't purge, then blocks reinstall (High)
**Finding (confirmed).** `commands/uninstall.ts:44` purges `[config, stash, workspace, data]` only — not `resolveStateDir()` or `resolveSystemDir()` (both exist, `home.ts:55-62`, and are exported, `index.ts:92-93`). Survivors: `state/stack.env` (with `OP_SETUP_COMPLETE`) trips `hasAnyStackEnvFile` and `system/stack/core.compose.yml` trips `hasMaterializedLocalInstall`, so the next plain `openpalm install` throws "already installed" — contradicting the purge's own "all data removed" message.

**Fix (verified, sound).** Add `resolveSystemDir()` and `resolveStateDir()` to the dirs list, ordered **before** `resolveDataDir()` so the lock-owning `data/` is removed last (the `purgeRemovedLock` guard at `:48` still fires on the final iteration). `state/`/`system/` hold no lock or in-use handle. Wiping `schema-version`/`host-identity.json` is correct — `install` re-creates them via `ensureHomeDirs`.

### C2 — No CLI `doctor` (Medium)
**Finding (confirmed).** The full docker/compose/port/GPU/runtime preflight lives only in the SvelteKit route `api/setup/system-check/+server.ts` — which won't render if Docker or the UI port is the problem. No `doctor`/`diagnose` in the CLI. The building blocks *are* in `@openpalm/lib` and CLI-reachable (`checkDocker`, `checkDockerCompose`, `detectRuntime`, `detectGpu`, `detectLocalProviders`); only the TCP port probe + `portHeldByOurContainer` are trapped inline in the UI route.

**Fix (verified, with one refinement).** Add `openpalm doctor` composing the exported lib checks + a small `node:net` port probe, registered via one `subCommands` key. **Audit refinement:** `portHeldByOurContainer` is **not** optional — a plain `checkPortAvailable` (127.0.0.1 bind test) run while the stack is **up** flags all three ports (3880/3800/3810) as conflicts, a false positive for exactly the operator whose stack is running. Fold in the docker-ownership check (or clearly label "in use — possibly by OpenPalm itself"). Mirror the wizard's port fallbacks.

**Decided: `doctor` is the unified diagnostics command.** Per maintainer decision, `openpalm doctor` also absorbs the storage diagnostics from #581 (see **S8**): a storage-report section (filesystem capacity, cache sizes, tool trees, Docker images/volumes, OpenCode DB/WAL/session-tree size) and a `--clean-caches` action for the purgeable cache paths, rather than a separate `openpalm storage` command. The **disk-headroom preflight** that S6/S8 want before install/update/backup/restart should be the **same** lifecycle preamble as D1's docker-readiness check — one preflight, two checks — not two independently bolted-on gates.

### C3 — Lost UI password = lockout; and a password change wrongly requires a restart (High)
**Finding (confirmed) — two problems, one of them a design flaw.** (1) There is no recovery path: one shared password (`session-store.ts:52-56`), no forgot-password flow, and `unlock` only clears the install lock. (2) The reason a naive file rewrite doesn't take effect — and the earlier draft's "restart the container" workaround — is a **design flaw, not a fact of life**: `getUiLoginPassword()` reads `process.env.OP_UI_LOGIN_PASSWORD` **first** (`session-store.ts:52-54`) and that env var is **snapshotted into the process at spawn** (`ui-server.ts:299`; `hooks.server.ts:73-75` only reads the file when the env is unset). So the running UI holds a stale copy and shadows any change to the file until the process/container restarts. Note that `readSecret` itself reads the file live on every call (`secrets-files.ts:35`) — the file is always fresh; it is purely the **env-first precedence + spawn-time snapshot** that forces the restart.

**Fix (address the root cause — no restart needed).**
1. **Make the password file the live source of truth.** Change `getUiLoginPassword()` to read the secret file authoritatively (host: `knowledge/secrets/op_ui_login_password`; container: the compose file-secret at `/run/secrets/ui_login_password` via `OP_UI_LOGIN_PASSWORD_FILE`), with a small **mtime/size-cached** read to avoid a disk hit per request, and demote `OP_UI_LOGIN_PASSWORD` to a fallback/override only. Because the file is bind-mounted live and `readSecret` already reads it fresh, a change then takes effect on the **next request** with no restart. Session invalidation remains automatic — `sessionSigningKey = HMAC(serverKey, sha256(password))` (`session-store.ts:93-95`), so rotating the password fails every outstanding cookie with no extra logout code.
2. **Add `openpalm reset-password`** that writes a new value via the existing `patchSecretsEnvFile`/`writeSecret` (`op_ui_login_password`) and prints it. With step 1 in place this is a pure file write — no `docker compose restart`, no instruction to restart a host-side `openpalm ui`/Electron process. (Without step 1, the command would have to restart the UI process; step 1 is what removes that.)

**Verification note.** The container-served UI's `*_FILE`→env conversion happens in the baked entrypoint (not in this repo), so step 1 must ensure the container path also reads `/run/secrets/ui_login_password` live rather than snapshotting it to env at boot; the compose file-secret is a live bind mount, so a live read there reflects host changes.

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

**Related (#581 finding #11):** pinning reduces *tag churn*, but the moving-`latest` + always-`--pull`/`--force-recreate` upgrade path also leaves **superseded images and orphan project-rename volumes** accumulating on disk. That retention/cleanup half is covered in **S7** — E1 (pin) and S7 (retention) are complementary, not substitutes.

### E2 — Assistant/guardian install & self-update packages at runtime; make the image the single source of truth (Medium)
**Re-scoped.** The first draft narrowly recommended "bake a skeleton fallback floor." The maintainer direction is broader and better: **remove the runtime package installs and self-update from the assistant and guardian entirely, bake everything into the image, and let users update by pulling a new image and updating the stack.** This subsumes the original air-gap-floor finding.

**Finding (confirmed).** All three service containers install packages at boot that are **also already baked at build time**, so the runtime step is redundant in the shipped-image case — but it introduces real problems:
- **Assistant** (`entrypoint.sh:64-136`) `npm install`s `@openpalm/ui` and `@openpalm/skeleton` (exact-pinned to `PLATFORM_VERSION`, soft-fail) and then `bun update --cwd /opt/openpalm/tools` — which **advances five semver-ranged tools on every boot** (`akm-cli ^0.8.0`, `@anthropic-ai/claude-code ^2.1.0`, `@openai/codex`, `@github/copilot`, `pi` — `containers/assistant/tools/package.json`; only `opencode-ai` is exact). So "same image tag" does **not** mean "same running code."
- **Guardian** (`entrypoint.sh:46-95`) and **portal** (`start.sh:22-32`) re-install their (exact-pinned) packages at boot. The guardian package/skeleton installs *do* skip when the exact version already matches (`install_artifact`, `:53-57`), **but the guardian tools `bun install` (`:90-92`) runs on every boot with no skip at all**, and `install_artifact`'s skip is a **string-equality** check (`:53-54`) that never matches a *range* override — so a range-pinned tool always re-installs (#581 finding #4). (An earlier draft of this finding wrongly called the guardian install "a no-op"; corrected here.) Their manifests are otherwise exact-pinned — the design has been trending toward "pin at release, not runtime" everywhere except the assistant's five ranged tools; guardian's own entrypoint comment (`:84-89`) states this explicitly and is the model the assistant should follow.
- **`opencode.jsonc:17`** declares `"plugin": ["akm-opencode@latest"]` — a `@latest` reference OpenCode resolves **itself at runtime**, a second runtime-fetch vector independent of the entrypoint scripts.
- **Two-manifest drift is live today:** the skeleton-seeded operator manifest differs from the image-baked one — portal seed `@openpalm/discord-portal: "^0.13.0-beta.13"` vs image-baked `0.12.44` (a full minor behind), guardian seed `akm-cli ^0.8.0` vs image `0.8.14`. A fresh install bind-mounts a manifest that resolves a *different, untested* version than the image was built and smoke-tested against. This is the fragility, demonstrated.
- The assistant image also bakes **no `@openpalm/skeleton` floor** (guardian does, `guardian/Dockerfile:71`), so an air-gapped first boot has nothing to fall back to (the original E2 gap).

**Fix (make the image authoritative).**
1. **Drop the assistant's runtime installs** (`entrypoint.sh:64-136`): remove the boot-time `npm install` of ui/skeleton and the `bun update` of tools — everything is already produced by the `toolbuild` stage (`Dockerfile:38-46`) and copied into the image. **Add the missing `@openpalm/skeleton` bake** to the assistant Dockerfile (mirroring the existing `@openpalm/ui` bake at `:191-197`) so the image is complete offline. This closes the original air-gap gap by construction.
2. **Exact-pin the assistant's five ranged tools** in `containers/assistant/tools/package.json` (as guardian/portal already do) and bump them explicitly at release time — no silent range advancement at boot.
3. **Pin the OpenCode plugin**: change `opencode.jsonc:17` `akm-opencode@latest` to an exact version baked at build; otherwise OpenCode still fetches `@latest` at runtime and "image is the sole source of truth" does not hold.
4. **Drop the guardian/portal runtime installs** (already baked + exact-pinned); keep at most a fast "does the baked version match what's expected" sanity check.
5. **Remove the two-manifest drift and the triple storage — one ownership model (decided: image-baked only).** Per maintainer decision, drop the `data/*/tools` bind mounts so operators run exactly what the image ships; overrides require an image rebuild. This is the single ownership model #581 P0.2 asks for (image-baked, **not** image + named-volume seed + nested bind), and it eliminates the live seed-vs-image drift above by construction. It also removes the guardian's seeded-but-unused `akm-cli` (its moderator denies all tools — #581 finding #4).
6. **Host-side UI/skeleton hot-swap is retained but its backup bloat is fixed under S5.** `npm-bundle-updater` (via `ui-server.ts:224-237`, `main.ts:329-342`) updates `OP_HOME/data/ui` and `OP_HOME/system` from npm on the **host** (CLI/Electron), independent of the container installs above; it exists to ship UI/config fixes without a full image pull and has fail-closed sha512 verification, so it is kept as a deliberate host-side channel. Its one storage problem — it adds unpruned `ui-*`/`skeleton-*` backups (#581 finding #9) — is addressed in **S5**, not by removing it.

**Trade-off (state plainly).** Image-baked-only **costs** the operator-editable `tools/package.json` override and the assistant's live tool advancement (auto-picking up patch/minor bumps without a new image). It **gains** reproducibility (what's in the image is what runs), removes the boot-time npm/bun network dependency, deletes ~120 lines of soft/hard-failure install logic plus the cache volumes and guardian `.npmrc` plumbing, and closes the drift-bug class shown above by construction. This matches the direction guardian and portal already took, and directly satisfies **#581 P0.1/P0.2**. See **Section 8** for the broader storage picture this feeds into (the redundant runtime installs are also a top cause of the production disk-exhaustion incident).

### E3 — Voice published out-of-band; silent drift (Low — keep the fix minimal)
**Finding (confirmed).** `publish-voice.yml` is `workflow_dispatch`-only and decoupled from `release.yml`; `voiceImageRef` defaults to the moving `latest-<variant>` tag. So the voice image can drift relative to the platform.

**Fix (minimal — do not over-engineer).** With a handful of installs in the wild, the elaborate runtime-compat-assertion idea is not worth building. Just add an opt-in `include_voice` input to `release.yml` (or make `publish-voice.yml` a `workflow_call`) so a release **can** stamp a matching `openpalm/voice:<version>-<variant>` alongside the platform. Keep it opt-in (voice images are heavy; cu121 is amd64-only). That's the whole fix — skip the `VOICE_CONTRACT` runtime assertion. (assistant-models is pinned at build time via `ARG`, so it doesn't drift at runtime; leave it.)

### E4 — Images unsigned/unattested (Medium)
**Finding (confirmed).** `release.yml` sets `provenance:false, sbom:false` for portal/guardian/assistant (`:516,580,703`); `publish-voice.yml`/`publish-assistant-models.yml` push unsigned. No cosign/attest anywhere. A registry compromise or tag overwrite is undetectable.

**Fix (verified — free, in-scope; implement it correctly so CI can't silently regress).** Add cosign **keyless** signing (GitHub OIDC + Fulcio/Rekor, no secret). Concretely, and with the correctness guardrails called out:
- Give each build-push step `id: build`, add `uses: sigstore/cosign-installer@v3` **pinned to a specific release** (don't float), then `cosign sign --yes <image>@${{ steps.build.outputs.digest }}`.
- **Sign by immutable digest, never by tag** — `steps.build.outputs.digest`, so the signature binds to the exact pushed artifact even as `latest` moves.
- **Gate on push:** run the sign step only when the image was actually pushed (`if: ${{ !inputs.dry_run }}` on portal/guardian/assistant, whose push is already `${{ !inputs.dry_run }}`; voice/assistant-models push unconditionally). Signing a not-pushed image fails the job — a classic CI bug to avoid.
- **Permissions:** `release.yml` needs **zero** changes (`id-token: write` already at `:98`). `publish-voice.yml`/`publish-assistant-models.yml` need `id-token: write` added to their `permissions:` blocks (they have only `contents: read` today).
- **Make it self-verifying so a broken signing config fails loudly, not silently:** add a `cosign verify --certificate-identity-regexp '<repo>' --certificate-oidc-issuer https://token.actions.githubusercontent.com <image>@<digest>` step immediately after signing in the same job. That turns a misconfigured signer into a red pipeline instead of unsigned images that look fine.
- **Roll out on a prerelease first** (this repo currently ships prereleases) to validate the whole path before a stable cut depends on it.
- Cosign signatures are a few-KB OCI artifact, so they do **not** trigger the Docker Hub multi-blob CDN 400 that forced `provenance/sbom` off — leave those off. Document the consumer verify command with the repo's OIDC identity + `https://token.actions.githubusercontent.com` issuer. (Re-enabling SBOM/provenance via a parallel GHCR push is optional and out of scope for this fix.)

---

## 7. Cross-runtime

### F1 — Rootless chown pass skipped on install (Low, corrected)
**Finding (corrected — see top).** Core services **are** protected under rootless via a `docker run alpine chown` reconcile + arbitrary-uid Dockerfiles. Do **not** generalize voice's drop-`user:` overlay — it would regress the design and break the `guardian-rootless`/`portal-rootless` guardrail tests. Real residual: `reconcileHostOwnership` is wired into `start`/`upgrade`/`up` but **not** `applyInstall`, so a one-shot fresh rootless install's first `up` can hit unwritable operator-owned bind dirs before any chown.

**Fix (verified, sound).** Call the existing `reconcileHostOwnership(state, { services: await buildManagedServices(state) })` inside `applyInstall` (`lifecycle.ts:243-246`), mirroring `performUpgrade` (`:280`) — both helpers are already imported there, so it's a one-line addition. The UI install route calls `applyInstall` before its own `applyStack`, so editing `applyInstall` alone suffices. Document the inherent rootless tradeoff (chown moves bind-dir ownership to the sub-uid range, so the host operator can no longer directly edit those files — already true on the start path). **Cross-link:** under Podman the chown mitigation itself breaks because it shells hardcoded `docker` (see F2).

### F2 — Hardcoded `docker` binary; Podman unusable (Medium)
**Finding (confirmed).** `"docker"` is hardcoded at every exec site (`docker.ts:92,419,484`, plus `voice-host-probes.ts`, `addon-availability.ts`, `launch-status.ts`, and several UI routes). Podman is only string-detected for the *display* label (`launch-status.ts:47-52`) — nothing switches the binary. On a Podman-only host every op ENOENTs while the UI cheerfully labels the runtime "Podman."

**Fix (verified — necessary but not sufficient).** Add `dockerBin()` (`OP_DOCKER_BIN` || `"docker"`) in `docker.ts` and route all exec sites through it (argv is already array-based, so only the program name changes; `docker.ts`'s shared `run` collapses most paths to three edits). **The audit is emphatic this seam alone doesn't deliver the "works on Podman" impact:** (1) `docker compose` needs Podman's Docker-compatible compose provider (podman ≥4.x); python `podman-compose` diverges on `--wait`/`--profile`/`--progress`; (2) `host.docker.internal:host-gateway` needs podman ≥4.7 (podman natively provides `host.containers.internal`); (3) `detectRootlessDocker` needs a podman branch (podman is rootless by default) — and this is load-bearing for F1, since both the rootless detection and the core-service chown mitigation depend on the binary resolving. Add a `<bin> compose version` preflight that surfaces a clear error when the provider is missing. Ship the seam as step one; full Podman support is medium effort beyond it.

---

## 8. Container storage growth (issue #581)

Source: **[#581](https://github.com/itlackey/openpalm/issues/581)** plus its detailed maintainer root-cause comment — a review of a real production disk-exhaustion incident ("krang"). Production evidence: root filesystem at **96% (2.5 GB free)**, one assistant tree **8.2 GB → 2.9 GB** after cleanup, the OpenCode SQLite DB **1.4 GB → 16 MB** after a single `VACUUM`, and a session tree **2,613 sessions deep (depth 33) → 9 roots**. A restart regenerated **4.7 GB** and filled `/` to 100%, at which point OpenCode/akm failed with SQLite `disk I/O error` and `restart: unless-stopped` repeated the work. Several root causes are the **same** as E2; the items below are cross-referenced where they overlap and marked "verified" (checked in current code) vs "per #581" (from the maintainer's cited review). This section folds in #581's own P0/P1 recommendations, checked for consistency with the plan.

### S1 — Regenerable caches/artifacts written into durable `data/` (Critical)
**Finding (verified + per #581 finding #1).** The filesystem contract says `data/` is durable service state and ephemeral artifacts belong under `~/.cache/openpalm/` (`docs/technical/core-principles.md`). But compose bind-mounts the whole assistant home from `${OP_HOME}/data/assistant`, and the entrypoint deliberately puts the npm and Bun caches **under that home** (so warm restarts reuse them) — so `.cache/bun`, `.cache/opencode`, npm caches, and Playwright/browser caches all grow inside durable `data/` and survive restarts and (historically) backups.
**Fix (#581 P0.3).** Move Bun/npm/OpenCode/Playwright caches to **independently purgeable cache volumes** or `~/.cache/openpalm`, with size/age caps and a supported `openpalm doctor --clean-caches` action (see S8/C2). Cleanup must never touch session DBs, credentials, knowledge, or operator manifests. **Boundary vs E2:** E2 removes the *install-time* cache churn; S1 relocates the *remaining* runtime caches — complementary, not the same fix.

### S2 — Triple-stored tool tree + boot-time `bun update` (Critical) — *fixed by E2*
**Finding (verified + per #581 findings #2, #3, #4).** The ~3.5 GB tool tree is stored **three times**: baked into the image, seeded into the `assistant-artifacts` named volume mounted over `/opt/openpalm`, then installed **again** into the `${OP_HOME}/data/assistant/tools` bind mount that hides the named-volume copy — the image and named-volume copies consume blocks but can't serve the active path. On top of that, the assistant's five ranged tools advance via `bun update` every boot, retaining multiple release + glibc/musl/baseline variants of 150–280 MB binaries with **no** size/age/version cap, and rerunning the Claude native installer even when unchanged. CI has already hit ENOSPC from this exact topology.
**Fix.** This is the storage face of **E2** — the decided **image-baked-only** model removes the runtime installs, the `bun update`, and the bind-mount duplication in one move, and drops the guardian's unused `akm-cli`. Add the **cache/binary retention cap** (S1) so even the baked tool set can't accumulate old native-binary variants. No separate fix beyond E2 + S1.

### S3 — OpenCode SQLite DB grows unbounded; no retention or compaction (Critical)
**Finding (per #581 finding #5).** The assistant's full home — including `.local/share/opencode/opencode.db`, its WAL, event rows, and part snapshots — is durable, and OpenPalm starts OpenCode with **no** age/count/size retention, event pruning, WAL checkpointing, or `VACUUM`/`PRAGMA optimize`. The event-sourced schema keeps full message/part snapshots plus current projections. In the incident, supported API deletion freed 353,448 pages **logically** but the file stayed 1.4 GB until an explicit `VACUUM` cut it to 16 MB — i.e. deletion alone does not reclaim disk.
**Fix (#581 P0.4).** Add configurable age/count/disk retention using OpenCode's supported session `DELETE` API: preserve active/recent roots, delete completed stale child trees, checkpoint the WAL, and **compact (`VACUUM`) when freelist/DB-size thresholds justify it** — deletion without compaction does not free space. Pair with bulk paginated UI/CLI visibility (see S4). This is net-new (no existing finding conflicts); it does reach into OpenCode's DB, an integration boundary to own deliberately.

### S4 — Portal session reuse is a dead contract; guardian eviction orphans sessions (High)
**Finding (per #581 findings #6, #7).** The portal SDK defaults to `server` session reuse and names the guardian the reuse authority, but the guardian has **no** server-side reuse cache and strips the session-key hint — so **every portal turn calls `createSession`**, producing a new retained root even when a stable thread key was supplied. Separately, the guardian evicts ownership rows after 10,000 entries **without deleting the underlying OpenCode session**, and its list endpoint filters to surviving rows — so evicted sessions become durable **orphans** that no principal can list or delete. (This refines the round-1 report, which praised the per-user ownership model without noting this unbounded-orphan leak.)
**Fix (#581 P0.5).** Either implement the guardian reuse cache that `server` mode promises, or make client reuse the supported default so a stable thread key reuses one session. Before owner-row eviction, delete/archive the upstream session or keep a reconciliation record so it stays manageable. Consistent with the G-series (guardian as the constrained authority); no conflict.

### S5 — Backup lifecycle defects (High) — *core defect already fixed; scope to the rest*
**Finding (verified + per #581 findings #8, #9).** The historical 5 GB full-`data/` backup defect **is already fixed** — `backup.ts:117-144` intentionally excludes `data/` (do **not** re-recommend it). What **remains**: backups are hardcoded under `${OP_HOME}/data/backups` on the **same filesystem** (`home.ts`), with no external destination; `checkBackupFreeSpace` is **dead code** (only tests call it) while `install --force` calls `backupOpenPalmHome` directly; backups are copied straight into their final visible directory with **no completion marker or torn-copy cleanup** (verified `backup.ts:128-144`); the host-side updater adds `ui-*`/`skeleton-*` snapshots **without pruning**; and pruning sorts a mixed namespace **lexicographically**, not by mtime/type (verified `backup.ts:146-153`). Docs (`managing-openpalm.md`) claim the free-space check runs and backups are never auto-pruned — both untrue.
**Fix (#581 P0.6; decided).** Add a **configurable external backup destination** (may live on another filesystem); default stays `data/backups` for compatibility. Every producer measures the *destination* filesystem and fails closed on measurement failure; write to a staging dir with a completion marker and clean torn copies; use typed metadata with chronological, per-purpose retention instead of one lexicographic directory; wire the currently-dead space guard. Update `docs/backup-restore.md` + `managing-openpalm.md` to match. **Interacts with C1:** `uninstall --purge` must also account for a configured external destination (an external backup dir won't be under `data/`, so purge won't remove it — decide whether purge should).

### S6 — Disk-pressure restart/install feedback loop (High)
**Finding (per #581 finding #10).** Services are `restart: unless-stopped`; the assistant runs all installs **before** launching OpenCode and treats a failed `bun update` as a warning. On disk-full, a restart regenerates GBs of cache, fills `/`, OpenCode/akm fail with SQLite I/O errors, and the restart policy repeats the package work — a loop with **no pre-install disk guard and no startup cache cleanup**.
**Fix.** Largely dissolved by E2 (no boot-time installs to regenerate) + S1 (caches capped/relocated). Add the **disk-headroom preflight** that fails closed before install/update/backup/restart — implemented as the **same** lifecycle preamble as D1's docker-readiness check (one preflight, two checks), surfaced by `openpalm doctor` (S8).

### S7 — Docker image/volume retention (Medium) — *complements E1*
**Finding (per #581 finding #11).** Fresh installs default image tags to moving `latest`; upgrades always `--pull` + `--force-recreate`, but there is **no image-retention cleanup**, so superseded OpenPalm images accumulate. Project rename tears down containers **without `-v`**, leaving orphan project-scoped volumes — which hold the hidden tool/cache copies from S2, making them especially expensive.
**Fix (#581 P1.8).** E1 (pin tags) reduces churn; S7 adds retention: report dangling superseded OpenPalm images and project-scoped orphan volumes, then an explicit **confirm-gated** cleanup that only removes verified OpenPalm-owned artifacts. Surface it via `openpalm doctor` (S8).

### S8 — No storage diagnostics or thresholds (Medium) — *folded into `openpalm doctor` (C2)*
**Finding (per #581 finding #12).** Assistant health checks only HTTP reachability; guardian stats expose ownership row counts but not DB/WAL/event size, session-tree depth, cache size, or growth; the shipped health task is disabled; and the documented 10 GB minimum is already below one image + tool tree + one regenerated cache + ordinary durable state.
**Fix (#581 P1.7; decided).** Rather than a separate `openpalm storage` command, extend **`openpalm doctor`** (C2) with a storage report — filesystem capacity, bind/cache sizes, active vs hidden `node_modules`, Docker images/volumes, backup classes, and OpenCode DB/WAL/freelist/event/session-depth counts — plus a `--clean-caches` action (S1) and threshold warnings that block/​warn before install/update/backup/restart (S6). Raise the documented minimum-disk requirement to match reality.

**Regression coverage (#581 P1.9).** Whatever subset is implemented, add tests for: repeated cold/warm restarts with **no** version movement; upgrades with bounded cache growth; the production mount topology (no duplicate hidden tools); ENOSPC startup behaviour; destination-aware backup preflight + atomic-failure cleanup; mixed backup retention; portal session reuse; owner-eviction reconciliation; large child-tree cleanup; and post-delete SQLite compaction.

## 9. UI code-quality follow-ups (issue #577)

Source: **[#577](https://github.com/itlackey/openpalm/issues/577)** (label `polish`). These are UI-internal TypeScript quality items — off-theme from this report's public-seams focus, included per request. Neither is a live bug; both verified in current code.

### U1 — Activation veto via a fragile `=== false` return (Low)
**Finding (verified).** `emitConnectionActivated` (`packages/ui/src/lib/connection-events.ts:74-79`) refuses activation with an implicit "listener returned literal `false`" check, and `ActivationListener`'s return type was widened to `unknown`. Safe today (only `chat.onEndpointChanged` vetoes, returning `boolean`; the other listener returns `undefined`), but any future predicate-style subscriber that happens to return `false` would silently abort and roll back activation, with no type-level signal.
**Fix (per #577).** Make the veto explicit — a dedicated typed result (`{ refuse: true }` or a named symbol) instead of overloading `false` — and narrow the listener return type so a plain boolean-returning listener can't accidentally veto. No conflict with any other finding.

### U2 — Redundant `getAll()` on first storage access (Low)
**Finding (verified).** `pickStorage`'s `select()` (`packages/ui/src/lib/connections/boot.ts:59-70`) runs `persistent.getAll()` purely to decide persistent-vs-memory and **discards** the result; the wrapper's first real `getAll()` then issues a **second** read. Low impact (connection sets are small), but the probe throws away entries it just read.
**Fix (per #577).** Have `select()` surface the probe's result so the first `getAll()` reuses it, or probe with a lighter open-only check. No conflict with any other finding.

## Suggested implementation order

Organized by tier. Security-critical and disk-stability work leads, since the production incident behind #581 shows disk exhaustion takes the whole stack down.

**Tier 0 — critical (security + disk stability):**
1. **G1 + E2 (+S2)** — the secret-exposure fix (relocate delegated secrets out of the stash, stop sourcing env:user into the OpenCode server, guardian `auth.json` via compose secret) ships in the **same new image-baked assistant** that removes the runtime installs, the boot-time `bun update`, and the triple tool-tree storage. One image, both fixes.
2. **S1 + S6** — relocate/cap the Bun/npm/OpenCode/Playwright caches out of durable `data/`, and add the fail-closed **disk-headroom preflight** (the *same* lifecycle preamble as D1). Together with E2 this ends the disk-fill restart loop.
3. **S3** — OpenCode DB retention + `VACUUM`/WAL checkpoint. The single biggest disk reclaimer (1.4 GB → 16 MB in the incident); net-new and larger, so start it early.

**Tier 1 — high-impact, low-risk:**
4. **C1, D1, C3, B1** — purge removes `state/`+`system/`; day-2 Docker errors (uses the Tier-0 preflight); password = live file source + `reset-password` (no restart); Windows checksum.
5. **S5** — backup lifecycle + **configurable external destination**; coordinate with C1 (purge must account for an external backup dir).
6. **A1** — repair or deliberately deprecate the npm channel.

**Tier 2 — portal trust + supply chain:**
7. **G3 + G2** — portals default-deny with a `"*"` explicit opt-in; repair the assistant denylist so "ask"/"deny" patterns actually match. Release note.
8. **S4** — portal session reuse + guardian owner-eviction reconciliation (portal-side, sits with G3/G2).
9. **E4** — cosign keyless signing with an in-CI verify step.

**Tier 3 — diagnostics, retention, versioning:**
10. **C2 + S8 + S7** — unified `openpalm doctor` (env preflight + storage report + `--clean-caches`) and confirm-gated Docker image/volume cleanup.
11. **E1** — pin image tags to `PLATFORM_VERSION` (complements S7).
12. **E3, F1** — minimal voice publish tie-in; rootless install-path chown.

**Tier 4 — smaller hardening + larger efforts:**
13. **B2, B3, B5, G6, G7, U1, U2** — Windows PATH/PS7/crontab; moderation weight; empty-key 401; the two #577 UI polish items.
14. **F2, B4, G5/G6 (guardian plugin)** — Podman seam; windows-arm64 (Bun target unknown); a future dedicated **guardian OpenCode plugin** for spend visibility (G5) and tool-output screening (G6).

*Deferred / not scheduled:* **B6** (accepted Windows limitation), **G4** (self-approval is by design).

---

## Method & confidence notes

- **Discovery** was performed by five parallel read-only exploration agents (CLI install seams, the compose stack, UI/Electron surfaces, distribution/release, portal+guardian security), each instructed to ignore documentation and cite file:line evidence.
- **Verification** of each finding and its recommended fix was performed by a second, structured pass: per-domain design + an independent adversarial audit that re-opened the files to confirm the finding held and the fix was correct, complete, and non-breaking. The "Fix verdict" column and the audit notes inline reflect that second pass.
- **Corrections:** two items (F1, and the original air-gap headline under E2) were overstated in the first pass and downgraded after verification — both turned out to be designed-but-incomplete mitigations rather than outright failures. The other 23 held up under adversarial re-verification.
- **Design-intent revision round.** After maintainer feedback, two further targeted investigations were run to get the recommendations right: (1) how akm actually loads secrets and what OpenCode's permission model can and cannot enforce (this reshaped G1/G2 — the key discovery being that OpenCode `read` denies are worktree-relative and that env:user is sourced into the OpenCode server's own process environment), and (2) exactly what the assistant/guardian/portal entrypoints install at runtime versus bake at build (this reshaped E2, and surfaced live seed-vs-image manifest drift). G4 was withdrawn as intended behaviour and B6 accepted as a Windows limitation on maintainer instruction.
- **Tracked-issue integration round (Sections 8–9).** Issues #581 and #577 were folded in after checking each item against the plan for contradictions. The genuine forks were resolved by maintainer decision: **image-baked tools only** (drop the operator override), a **unified `openpalm doctor`** (absorbing #581's storage report/clean rather than a separate command), and a **configurable external backup destination**. Items independently re-verified in code: U1/U2 (#577), the guardian tools-install/skip-check behaviour, the already-landed full-`data/` backup exclusion, and the backup prune ordering. The remaining #581 items (cache-in-`data/`, SQLite growth, session orphans, image/volume retention) are cited from the maintainer's detailed root-cause review with its file:line references and are marked "per #581" rather than independently re-verified here. One earlier statement was corrected in both directions: E2 no longer calls the guardian install "a no-op," and the round-1 praise of the guardian session-ownership model is qualified by S4's orphan leak.
- This report is **point-in-time** against `a73a6b4`. Line numbers will drift as the code changes; treat the file:function citations as the durable anchor.
