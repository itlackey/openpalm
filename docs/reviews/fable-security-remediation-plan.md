# Fable Security Remediation Plan (Part B, standalone)

Date: 2026-07-05 · Tree: `main@002b715b` (the exact commit the reviews, the verification
pass, and the security pass all ran against; every file:line below was re-read in this tree
while authoring this plan).

## Implementation Status

| Item | Status | Note |
|---|---|---|
| S.1a | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran both checks directly in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/S.1a automation/fable-remediation` → exit_code=0 (S.1a IS an ancestor of fable-remediation). 2. `git log automation/fable-remediation --oneline -5` output: 8a319127 fix(S.1a): merge verified plan item, f1a6899e docs: update implementation status for 3.6, 27a38459 fix(3.6): merge verified plan item, 8de2395d docs: update implementation status for 3.5, 29ce450b fix(3.5): merge verified plan item. The top commit (8a319127) is explicitly "fix(S.1a): merge verified plan item" — confirming S.1a was merged into automation/fable-remediation as its most recent commit. Both conditions verified true independently. |
| S.4 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1) `git merge-base --is-ancestor automation/S.4 automation/fable-remediation` -> exit code 0 (confirmed via `echo $?`), meaning S.4 IS an ancestor of fable-remediation. 2) `git log automation/fable-remediation --oneline -5` output: 226c558f fix(S.4): merge verified plan item, fc8f3324 docs: update implementation status for S.1a, 8a319127 fix(S.1a): merge verified plan item, f1a6899e docs: update implementation status for 3.6, 27a38459 fix(3.6): merge verified plan item. The HEAD commit of automation/fable-remediation is explicitly labeled "fix(S.4): merge verified plan item", confirming S.4 was merged. |
| S.6a | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran independently in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1) `git merge-base --is-ancestor automation/S.6a automation/fable-remediation` -> exit code 0 (confirmed via echo $? immediately after). 2) `git log automation/fable-remediation --oneline -5` output: 36c01e8d fix(S.6a): merge verified plan item, 035b0380 docs: update implementation status for S.4, 226c558f fix(S.4): merge verified plan item, fc8f3324 docs: update implementation status for S.1a, 8a319127 fix(S.1a): merge verified plan item. Top (most recent) commit on fable-remediation is explicitly "fix(S.6a): merge verified plan item". Additional corroboration: `git merge-base automation/S.6a automation/fable-remediation` returned commit 9a238987..., which matches the tip of automation/S.6a exactly (`9a238987 fix(skeleton): pin ollama addon image by exact version + digest (S.6a)`, confirmed via `git log automation/S.6a --oneline -3`). This proves the full S.6a branch tip was merged in, not just a partial/cherry-picked commit. |
| S.7 | DONE | Re-verified tests green, merged into automation/fable-remediation, independently confirmed. Ran directly in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base: 1. `git merge-base --is-ancestor automation/S.7 automation/fable-remediation` → exit code 0 (confirmed via `echo $?`). Verified independently: `git merge-base automation/S.7 automation/fable-remediation` = 4cbd66eadada431cbeb812d1e0dbfa7b8c66a7b6, which equals `git rev-parse automation/S.7` exactly — i.e. S.7's tip IS the merge-base, proving true ancestry. 2. `git log automation/fable-remediation --oneline -5` output: 8cd394d6 fix(S.7): merge verified plan item, 77bcd8c9 docs: update implementation status for S.6a, 36c01e8d fix(S.6a): merge verified plan item, 035b0380 docs: update implementation status for S.4, 226c558f fix(S.4): merge verified plan item. The tip commit (8cd394d6) is explicitly labeled "fix(S.7): merge verified plan item" — a named merge commit for S.7 is present at HEAD of fable-remediation. Both the ancestry check and the log both independently confirm S.7 has been merged into automation/fable-remediation. |
| S.8 | DONE | Completed and merged into automation/fable-remediation, independently verified. Ran both checks in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base. `git merge-base --is-ancestor automation/S.8-v2 automation/fable-remediation` exited 0 (S.8-v2 tip 3df7ed07 is an ancestor of fable-remediation tip 81e57b5c). Cross-checked with `git branch automation/fable-remediation --contains automation/S.8-v2`, which lists automation/fable-remediation. `git log automation/fable-remediation --oneline -3` shows the top commit as a S.8 commit: `81e57b5c fix(S.8): guardian ingress hardening (heuristics, rewrite whitelist, p...)` (followed by 1c8052e4 docs: status 1.3 -> DONE, e7545e32 fix(1.3): ...). |
| S.3 | DONE | TDD green, Opus-approved, merged into automation/fable-remediation, independently verified in 1 round(s). Verified directly in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base. `git merge-base --is-ancestor automation/S.3 automation/fable-remediation` exited 0 (EXIT_CODE=0), confirming automation/S.3 is an ancestor of automation/fable-remediation. `git log automation/fable-remediation --oneline -3` shows S.3 commits at HEAD: 6f389cf5 "fix(S.3): Content-validation default ON, fail-closed (D2=a)", 3a4dc3ef "fix(S.3): default guardian content-validation ON when flag unset", ddce47e4 "fix(S.2.1): guardian secret-audit ACL accepts op_guardian_ + shipped-compose fixture test". The two most recent commits are explicitly S.3, so S.3 is both an ancestor and present in the recent log. |
| S.6b | DONE | TDD green, Opus-approved, merged into automation/fable-remediation, independently verified in 1 round(s). Verified directly in .claude/worktrees/fable/_base. (1) `git merge-base --is-ancestor automation/S.6b automation/fable-remediation` exits 0 (EXIT_ANCESTOR=0) — automation/S.6b (tip c68cbe64) IS an ancestor of automation/fable-remediation (tip 32ff33fb). (2) `git log automation/fable-remediation --oneline -3` shows the tip commit is `32ff33fb fix(S.6b): Segment addons off assistant_net (D3=b)` — an S.6b commit is present. Note: the automation/S.6b branch-tip commit c68cbe64 ("security(S.6b): segment addons onto addon_net off the assistant trust network") differs from the S.6b commit at the remediation tip (32ff33fb, D3=b variant); c68cbe64 sits at position 4 in the remediation log and is confirmed reachable. Both requested claims are true. |
| S.2.2 | DONE | TDD green, Opus-approved, merged into automation/fable-remediation, independently verified in 1 round(s). Ran both commands in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base. `git merge-base --is-ancestor automation/S.2.2 automation/fable-remediation` returned exit code 0 (S.2.2 IS an ancestor). `git log automation/fable-remediation --oneline -3` shows the S.2.2 commit as HEAD: `8b0b1e36 fix(S.2.2): Wire secret audit into the apply path + document the model`, followed by `bfbb2474 docs: status S.6b -> DONE` and `32ff33fb fix(S.6b): Segment addons off assistant_net (D3=b)`. Both branch refs resolved without error. Both claims confirmed. |
| S.1b | DONE | TDD green, Opus-approved, merged into automation/fable-remediation, independently verified in 1 round(s). Ran both commands directly in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base. 1. `git merge-base --is-ancestor automation/S.1b automation/fable-remediation` → EXIT: 0 (S.1b IS an ancestor of fable-remediation). 2. `git log automation/fable-remediation --oneline -3` shows an S.1b commit at the tip: da92e4e1 fix(S.1b): Make the guardian edge functional + authenticated (D1=a) + p; 7ebb7253 docs: status 3.1 -> DONE; 7978cd46 fix(3.1): Install-lock correctness and coverage. Branch tips: automation/S.1b = 0d86c99e, automation/fable-remediation = da92e4e1. Additional confirmation: S.1b's actual tip commit 0d86c99e ("security(guardian): S.1b wire the OpenAI-compatible edge + pre-auth hygiene") is confirmed present in fable-remediation history via `git merge-base --is-ancestor 0d86c99e automation/fable-remediation` → EXIT 0, and appears in the full git log. Both conditions hold: is-ancestor exits 0, and the log shows S.1b commits merged into fable-remediation. |
| S.5 | DONE | TDD green, Opus-approved, merged into automation/fable-remediation, independently verified in 1 round(s). Ran both commands in /home/founder3/code/github/itlackey/openpalm/.claude/worktrees/fable/_base. `git merge-base --is-ancestor automation/S.5 automation/fable-remediation` exited 0 (S.5 tip 296ed590 is an ancestor of fable-remediation). `git log automation/fable-remediation --oneline -3` shows two S.5 commits at the top: `b7cfcf52 fix(S.5): Authenticate + bind guardian internal /stats (D4=c)` and `296ed590 fix(guardian): authenticate and narrow the internal /stats endpoint (S.5)` (third: `1a2d8731 docs: status S.1b -> DONE`). Additionally `git branch --contains automation/S.5` lists automation/fable-remediation. Note 296ed590 is the actual tip of automation/S.5, and fable-remediation carries an extra S.5 follow-up commit (b7cfcf52) on top. Both claims CONFIRMED independently. |

Sources: the security pass appended to `fable-verification-pass.md` (which confirmed every
previously-deferred security finding, understated two, and corrected five), drawing on
`fable-review-3-guardian-ingress.md`, `fable-review-4-attack-surface.md`,
`fable-review-5-secret-boundary.md`, and the security bullets of reviews 1, 8, and 10.
This is the detailed expansion of **Part B** of `fable-remediation-plan.md`; the summary
there defers to this document.

Nature of the work: this is **first-party defensive hardening of the maintainer's own
platform** — closing fail-open defaults, wiring dormant validation, pinning supply chains,
and making the docs tell the truth. No new attack capability is described here that the
review corpus does not already contain.

---

## 0. Preconditions and posture

### 0.1 Entry conditions

- **Part A is complete** (or at minimum Phase 0 and Phase 1). Two hard dependencies:
  Part A 1.3 rewrote the non-security docs that S.7 amends (avoid double-editing
  `core-principles.md` in flight), and Part A 3.4's test scaffolding is where S.1/S.5's
  negative tests live.
- **The standing constraint held**: nothing in Part A wired `PRINCIPAL_SECRET_FILE` or
  `OPENAI_COMPAT_API_KEY_FILE`, changed bind defaults, or advertised the auth seam. Verify
  this with a grep before starting — if the constraint was violated, S.1 is no longer
  deferred work; it is an incident.

### 0.2 Why the shipped stack is currently "broken, not open" — and why that is fragile

The full chain, verified in this tree:

1. `packages/guardian/src/openai-api.ts:126-133` (`checkOpenAIAuth`) and `:136-140`
   (`checkAnthropicAuth`) both begin `if (!this.apiKey) return true;` — **fail-open**.
2. `apiKey` reads `OPENAI_COMPAT_API_KEY_FILE` (`:110`), which is set **nowhere** in the
   shipped stack — only the read site exists. So the fail-open branch is the live branch.
3. The edge's upstream credential is `secret` ← `PRINCIPAL_SECRET_FILE` (`:114`). That var
   is set only for the discord (`portals.compose.yml:17`) and slack (`:58`) services — **not**
   in the guardian block, whose co-process serves the OpenAI edge. So the edge presents
   `Basic api:<empty>` to `/oc`, and the seeded `api` principal (real hash) rejects it: 401.
4. **The near-miss:** the guardian block already mounts `PORTAL_CHAT_SECRET_FILE:
   /run/secrets/portal_chat_secret` and `PORTAL_API_SECRET_FILE: /run/secrets/portal_api_secret`
   (`portals.compose.yml:119-120`). The working secret is *in the container* under the wrong
   env name. One line (`PRINCIPAL_SECRET_FILE: /run/secrets/portal_api_secret`) makes the
   edge functional — and, because `checkOpenAIAuth` depends only on `apiKey`, simultaneously
   **keyless-and-open** on published ports 3820/3821 (`portals.compose.yml:130-131`), whose
   loopback default is env-overridable (`OP_BIND_ADDRESS` / `OP_CHAT_BIND_ADDRESS` /
   `OP_API_BIND_ADDRESS`).

Any well-meaning operator or future patch that "fixes chat" activates the hole. That is why
S.1 leads this plan and why the two changes inside it (close the gate, then wire the edge)
are ordered and inseparable.

### 0.3 Decisions requiring human sign-off (collect before implementation)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | OpenAI/Anthropic edge shipped posture | (a) ship enabled + authenticated; (b) ship disabled, document | (a) — the ports are already published and the UI advertises chat; ship it working and keyed |
| D2 | Content-validation intended posture | (a) ON, fail-closed for portal traffic (matches shipped compose); (b) opt-in off (matches docs) | (a) — make code + docs match what actually ships |
| D3 | Addon-network trust boundary | (a) re-enable upstream OpenCode auth; (b) segment addons off `assistant_net`; (c) both; (d) document-only interim | (b) now, (a) as follow-up — see S.6 |
| D4 | `/stats` exposure | (a) require admin token; (b) bind internal listener to guardian-net interface only; (c) both | (c) — both are one-liners |

---

## S.1 Close the fail-open OpenAI/Anthropic edge; then make the edge honest

*(rev3-F1, rev4-F2, rev10-F4, X7, G-SEAM, rev3-F3 · the finding the security pass sharpened
most · blocks everything that touches principals)*

**Step 1 — fail closed (land alone, first):**

- Invert both gates in `packages/guardian/src/openai-api.ts`: no configured API key ⇒
  **401 every request**, mirroring the admin listener's empty-token-denies-all discipline.
  Delete the `if (!this.apiKey) return true;` lines (`:127`, `:137`); the remaining logic
  (Bearer / `x-api-key` extraction + `constantTimeEqual`) is already correct.
- A softer variant (refuse only when bound non-loopback) was considered and **rejected**: the
  bind address is decided by compose, invisible to this process, and "loopback" is not a
  trust boundary on a machine that runs other software.
- **Attribution correction honored (security pass):** the `AuthStrategy` seam's default
  `basicTokenAuthStrategy` (`auth.ts:77-99`) fails **closed** — the defect is confined to the
  openai-api layer, which bypasses the seam entirely (it builds its own `OcClient` with
  `Basic api:<secret>`). Fix the openai-api layer; do not "harden" the seam that is already
  correct. Optionally route this edge through the seam afterward so there is one auth
  chokepoint — as a follow-up, not mixed into the fail-closed diff.
- Tests (extend `packages/guardian/src` suites): no key configured → 401 on `/v1/*` and the
  Anthropic route; wrong key → 401; correct key → 200 path unchanged. These are the
  regression tests that make the gate's polarity load-bearing forever.

**Step 2 — make the shipped edge functional and authenticated (per D1(a)):**

- Guardian block of `packages/skeleton/system/stack/portals.compose.yml`: add
  `PRINCIPAL_SECRET_FILE: /run/secrets/portal_api_secret` (the secret is already mounted,
  §0.2.4) and `OPENAI_COMPAT_API_KEY_FILE: /run/secrets/portal_chat_secret` — or mint a
  dedicated `op_api_key` secret via the existing `ensurePortalSecret` path if reusing the
  chat secret muddies the audit trail (preferred; ~5 lines in secrets seeding).
- Surface the API key to the user in the UI connections page (it is the credential they paste
  into OpenAI-compatible clients) — read path only, no logging.
- If D1 resolves to (b) instead: remove the two `ports:` publications for 3820/3821 and
  document the edge as disabled; the fail-closed gate from Step 1 still lands.

**Step 3 — pre-auth hygiene (rev3-F3):**

- In the guardian request pipeline, move the body read after `authenticate()`; add a coarse
  pre-auth rate limiter (per-IP token bucket, generous limits — it exists to blunt
  credential-stuffing and body-flood, not to rate-limit users; the authenticated per-user
  limiter stays authoritative).

**Exit:** fail-closed tests green; `docker compose config` shows the edge keyed (or ports
removed); a curl with no key against 3820/3821 returns 401 on a live dev stack.

## S.2 Secret audit: fix the false positives, THEN wire validation into the apply path

*(rev5-F1, rev5-F2 — UNDERSTATED by the original review: the auto-apply path runs NO
validation at all · strict internal ordering)*

1. **Fix the ACL** (`packages/lib/src/control-plane/secret-audit.ts:108-110`): the guardian
   rule `secretId.startsWith('guardian_') || secretId.startsWith('portal_')` false-flags the
   two secrets the shipped compose actually grants the guardian —
   `op_guardian_admin_token` and `op_guardian_mcp_token` (`portals.compose.yml:117-118`;
   reproduced live by the security pass). Extend the rule to accept the `op_guardian_`
   prefix (or normalize the `op_` prefix before matching, consistent with how
   `normalizedSecretName` already strips `portal[-_]`). Add a fixture test that audits the
   *actual shipped* compose files and asserts **zero issues** — that test is the standing
   guarantee that step 2 can never brick apply.
2. **Wire the audit in**: invoke `auditComposeSecrets` + `validateProposedState` in the
   apply path (`deploy.ts` / `lifecycle.ts`) — today **neither is invoked anywhere**
   outside the manual `openpalm audit-secrets` command, making core-principles' "validates
   proposed changes before writing anything" claim doubly false. Fail the apply on `error`
   severity, log-and-continue on `warn`, and route the failure through the same
   user-visible error surface as compose failures.
3. **Document the authorization model** (rev1-F9): the actual rules — assistant
   `/^(assistant|opencode|provider|llm|embedding|akm|user)_/`, guardian `guardian_` +
   `portal_` (+ `op_guardian_` after step 1), admin `/^(admin|ui|openpalm)_/`, portal
   services `portal_<id>_`/`<id>_`, default `<serviceId>_` — currently live only in the
   tool's source. Put the table in `docs/technical/core-principles.md`'s secret-boundary
   section (coordinates with S.7).

**Ordering is load-bearing:** wiring before fixing would break every apply on the shipped
stack's own false positives.

## S.3 Content-validation posture: one truth across code, compose, entrypoint, and docs

*(rev4-F3, rev8-D1, X8 · per D2(a))*

Verified reality, all four layers: code default **off** when env unset
(`packages/guardian/src/moderation.ts:33` `envFlag`), compose ships **ON**
(`portals.compose.yml:108` `${GUARDIAN_CONTENT_VALIDATION:-1}`), entrypoint hard-fails boot
when ON and opencode missing (`containers/guardian/entrypoint.sh:87-95`), docs say
"opt-in and off by default" (`core-principles.md:7,59` — twice, per the corrected miscount;
CLAUDE.md says the same).

- Make the **code default ON** for portal-kind traffic so posture no longer depends on a
  compose interpolation default that any env override silently flips. Keep the env flag as
  the explicit opt-out; keep fail-closed semantics on moderator unreachability.
- Keep the entrypoint assertion; it is correct and already fail-closed.
- Ensure every moderation rejection emits a structured log with `requestId` + rejection
  reason (verify the existing log shape; document it) so an operator debugging silently
  dropped traffic has a trail — this is the operational half of the finding: today they
  won't suspect a stage the docs call "off."
- Doc sentences move to S.7's batch.
- Test: flag unset → portal message still moderated; flag `0` → bypass; moderator down +
  ON → request blocked, structured log emitted.

## S.4 Finish baking the guardian (and portal adapters) into their images

*(rev10-F1, X11 — verified end-to-end: the trust boundary's own code is fetched from npm at
boot · net-negative entrypoint)*

Verified: the image bakes `GUARDIAN_VERSION` (ARG→ENV) but **not the package** —
`containers/guardian/entrypoint.sh:49-73` `install_artifact` runs
`bun add ${OP_GUARDIAN_PACKAGE}@${VERSION}` (3 retries) for `@openpalm/guardian` **and**
`@openpalm/skeleton` on first boot, honoring env-selectable `OP_GUARDIAN_PACKAGE` /
`OP_GUARDIAN_ENTRY` and an operator-suppliable `.npmrc`, with no lockfile or integrity hash;
`:80-81` additionally runs `bun update --cwd /opt/openpalm/tools` **every** boot. The portal
image does the same for adapters (`containers/portal/Dockerfile:2-4`).

- **Finish the baking already begun** (the security pass's refined remedy — this is
  completion, not invention): in `containers/guardian/Dockerfile`, install
  `@openpalm/guardian@${GUARDIAN_VERSION}` + `@openpalm/skeleton` at build time into the
  image layers. `install_artifact`'s existing already-at-version check then makes boot a
  no-op in the default case; it remains as the explicit-override path for
  `OP_GUARDIAN_NPM_VERSION`/`OP_GUARDIAN_PACKAGE` users. First-boot-offline starts working
  as a side effect.
- Replace boot-time `bun update` of tools and portal adapters with **exact-pinned installs**
  at build time; semver-range advance moves to release time where it is reviewed and tested.
  (Coordinate with the release-unit process in Part A 3.3; per the standing rule, any
  `release.yml` change ships as a proposed diff for owner approval.)
- Emit **one structured boot line** naming the active `package@version` + entry + auth
  strategy — the reproducibility receipt for every running guardian.
- Document `OP_GUARDIAN_PACKAGE` / `OP_GUARDIAN_ENTRY` / `.npmrc` / `setAuthStrategy()` as a
  **downstream-distribution contract** (build-your-own-image), not a runtime feature of the
  shipped stack.
- Mind Docker Hub layer limits (per project memory: per-package `RUN`s, scoped `chmod`,
  `provenance: false` + `sbom: false`).
- Test: build the image with registry access, then `docker run --network none` — guardian
  must reach healthy. That single test encodes the whole invariant.

## S.5 Authenticate and bind the guardian internal `/stats`

*(rev4-F5 · per D4(c) · two one-liners + a test)*

Verified: `packages/guardian/src/server.ts:107` serves `/stats` on `handleInternalRequest`
with no auth; `statsResponse` (`:44-79`) returns the principal roster (ids, kinds, labels —
`tokenHash` is stripped, so no secret material), direct-ingress/MCP flags, rate-limit
config, and proxy/ownership counters; `Bun.serve({ port: INTERNAL_PORT, ... })` (`:183`)
sets no hostname, so Bun binds all interfaces — reachable from **both** bridge networks,
a ready-made reconnaissance next-hop for anything that lands via S.6's addon boundary.

- Require the existing admin token (`GUARDIAN_ADMIN_TOKEN_FILE` is already in the
  environment) on `/stats`, or relocate it to the admin listener where auth already lives.
- Add `hostname` to the internal listener's `Bun.serve` so it binds the guardian-net
  interface (or at minimum document why it must stay wide).
- Negative test: unauthenticated `/stats` → 401; keep one authenticated assertion on the
  response shape so the endpoint stays useful for ops.

## S.6 The addon-network trust boundary

*(rev4-F1 — the strongest confirmed attack-surface item, HIGH · per D3(b) now, D3(a) later)*

Verified chain: `OPENCODE_AUTH: "false"` (`core.compose.yml:53`, with the comment at
`:44-52` recording that guardian-side upstream-auth plumbing was deliberately removed) +
`opencode web --hostname 0.0.0.0` (`containers/assistant/entrypoint.sh:281`) + six addon
service definitions on `assistant_net` (`services.compose.yml`), including unpinned
`ollama/ollama:latest`. Net effect: **any third-party addon image sits inside the trust
boundary with credential-free access to the full OpenCode API** — sessions, tools, files,
and (via the assistant's admin-API reach) stack operations.

- **Immediate, independent of D3 (do first, tiny):** pin every addon image by exact version
  or digest — starting with ollama. Unpinned `:latest` inside the trust boundary means a
  registry-side publish is a same-day code-execution path into the assistant's network.
- **Structural (per D3(b)):** segment addons onto an `addon_net` that can reach what addons
  actually need (guardian-mediated endpoints) but not the assistant's :4096 directly. Sweep
  `services.compose.yml` for which addons genuinely require assistant reachability
  (voice STT/TTS callbacks are the likely exception — verify each) and grant per-service,
  not by shared network membership.
- **Follow-up (D3(a)):** re-enabling upstream OpenCode auth means rebuilding the removed
  guardian-side plumbing; per project memory, OpenCode's native server offers only a single
  global Basic credential — workable for one internal caller (guardian), and the compose
  comment must be rewritten from "not a supported hardening path" to describe whichever
  state ships.
- **If D3 stalls entirely:** the interim mitigation is documentation — the addon-enable UI
  and docs must state plainly that enabling a third-party addon grants it full assistant
  access. Silence is the current, worst, state.
- Test: from a container on the addon network, the assistant API is unreachable; from the
  guardian, it still works. Upgrade-path test: existing enabled addons survive the network
  migration (per the standing test-the-upgrade-path rule).

## S.7 Security-posture documentation truth (one batch, after S.1–S.6 decide the facts)

*(rev8 Tier 1 D1–D4 + D7 + D12 + D18 + D21 + D22; rev10-F5 security half; rev3-F4/F7;
CLAUDE.md:242 · docs only, but every sentence states posture, so it lands LAST, describing
what the code now does)*

- **Replace the fictional pipeline description** (`CLAUDE.md:242`: "HMAC, replay, rate
  limit, content validation, forward" at `containers/guardian/src/server.ts`): real source
  is `packages/guardian/src/`; auth is HTTP Basic + sha256 token compare
  (`auth.ts:77-99`); `replay.ts` does not exist. Purge the vestigial HMAC/nonce/replay
  comments at `proxy.ts:170-171,311,418` and `oc-bounds.ts:38,74` (verified present) —
  comments narrating deleted machinery are how the next review gets misled again.
- **Port table**, with the security pass's extra drift: guardian publishes
  3830 (bind-overridable), 3831 (admin, hardcoded 127.0.0.1), 3820 and 3821 — the latter
  two both mapping to the **same** internal listener 8182 (`portals.compose.yml:129-132`);
  voice internal is 8880, not 8186; the 8080 internal cell was verified correct — keep it.
  Note which bindings are env-overridable and by which `OP_*_BIND_ADDRESS` var.
- **`OP_ALLOW_REMOTE_SETUP`** is an explicit opt-in, not "impossible under any
  configuration".
- **Invariant-3 mount lists** (D7): `system/guardian` → `/etc/opencode`
  (`OPENCODE_CONFIG_DIR`, where instructions load), `config/guardian` →
  `~/.config/opencode`, plus `/host-stash` — matching what Part A 1.2's moderation.md
  decision assumed.
- **Content-validation posture** per S.3's landed state — fix both `core-principles.md:7,59`
  sentences and the CLAUDE.md echo.
- **Guardian-as-profile-gated ingress**: it lives in `portals.compose.yml` behind profiles,
  not unconditionally; say so.
- Assistant→Admin-API auth path (D12); delete the dead `ADMIN_TOKEN` reference (D18);
  guardian admin-listener description (D21); assistant-token docs (D22). (D20's dead
  `data/secrets` provider is deleted in Part A 3.5 — cross-reference, don't duplicate.)
- **State the `x-openpalm-user` trust model plainly** (rev3-F4, confirmed by construction):
  isolation is between *principals*; a portal fronts many users under one principal token,
  so the header is trusted from an authenticated principal. A documented design property,
  not a bug — but undocumented it reads as an oversight, and someone will "fix" it.
- Secret-authorization table from S.2.3 lands in the same PR.
- **Exit check:** the doc's port/mount/posture claims are diffed against live
  `docker compose config` output on a dev stack — the same discipline that caught this
  drift, now run once as an acceptance gate.

## S.8 Remaining guardian ingress hardening (lower severity, close-out)

*(rev3-F2 heuristic gaps, rev3-F5, rev3-F8 · small, independent, can trail)*

- **rev3-F2 / content-screen gaps:** extend the heuristic table for the reviewed gap classes
  (non-`parts[].text` content locations, sub-threshold accumulation). Part A 3.4's
  table-driven `content-screen.ts` unit test is the harness; extend the table and tests
  together.
- **rev3-F5 rewrite spread:** the prompt-rewrite path spreads non-`parts` fields from the
  inbound body into the upstream request. Whitelist the copied fields explicitly; add a
  test asserting an unexpected field does not survive the rewrite.
- **rev3-F8 global frames:** scope broadcast frames per-principal instead of fanning global
  frames out to direct principals; test that principal A's frames never reach principal B's
  stream.

---

## Sequencing and independence

```
S.1 step 1 (fail-closed)  ──►  S.1 steps 2–3 (wire edge, pre-auth hygiene)
S.2.1 (ACL fix)           ──►  S.2.2 (wire audit into apply)          [strict order]
S.3, S.4, S.5             — independent of each other and of S.1/S.2; any order
S.6 pin-images            — immediate, independent
S.6 network segmentation  — after D3 sign-off; the only multi-day item
S.7 docs                  — LAST (describes the landed state of S.1–S.6)
S.8                       — trailing close-out, independent
```

Parallelism note (from Part A's lesson): S.1 and S.5 touch `packages/guardian/src/server.ts`
adjacency — sequence those two serially or in one PR; everything else is disjoint files.

## Part B exit gate

1. Fail-closed tests green on both openai-api edges; unauthenticated curl against 3820/3821
   and `/stats` returns 401 on a live dev stack.
2. `openpalm audit-secrets` reports zero issues on the shipped stack, **and** the apply path
   refuses a compose change that grants an unauthorized secret.
3. A guardian image boots to healthy with `--network none`.
4. Content-validation posture identical in code default, compose, entrypoint assertion, and
   docs.
5. Addon images pinned; addon-net reachability test green (or the D3 interim documentation
   shipped, loudly).
6. Docs' security sections diff-clean against `docker compose config`.
7. All work committed clean per the non-negotiable rule: zero errors, zero warnings, zero
   test failures (`bun run test`, guardian suite, `bun run ui:check`, CLI typecheck).

---

## Appendix — Traceability: every security finding → plan item

| Finding | Verified at | Plan item |
|---|---|---|
| rev3-F1 / rev4-F2 / rev10-F4 / X7 edge fail-open, keyless by default | `openai-api.ts:127,137,110,114`; `portals.compose.yml:130-131` | S.1 |
| G-SEAM (fail-open masked by broken principal secret; one env line activates it) | `portals.compose.yml:119-120` (secret present under wrong name) | §0.2, S.1 |
| rev10-F1 auth-seam mis-attribution (seam fails closed; openai layer bypasses it) | `auth.ts:77-99` | S.1 (correction honored) |
| rev3-F3 body read before auth; no pre-auth limit | guardian pipeline | S.1 step 3 |
| rev5-F1 audit false positives on shipped stack | `secret-audit.ts:108-110`; `portals.compose.yml:117-118` | S.2.1 |
| rev5-F2 auto-apply runs no validation (UNDERSTATED) | no `auditComposeSecrets`/`validateProposedState` call sites in apply path | S.2.2 |
| rev1-F9 secret-name ACL known only to the tool | `secret-audit.ts:101-118` | S.2.3 + S.7 |
| rev4-F3 / rev8-D1 / X8 content-validation posture split (code off / compose ON / docs "off") | `moderation.ts:33`; `portals.compose.yml:108`; `core-principles.md:7,59` | S.3 |
| rev4-F3 miscount correction ("four times" → twice) | `core-principles.md:7,59` | S.3 / S.7 |
| rev10-F1 / X11 boot-time npm assembly of the trust boundary | `containers/guardian/entrypoint.sh:49-81` | S.4 |
| rev8-D14 behavioral half (adapters `bun update`d at boot) | `containers/portal/Dockerfile:2-4` | S.4 |
| rev4-F5 unauthenticated `/stats`, all-interfaces bind | `server.ts:44-79,107,183` | S.5 |
| rev4-F1 addon-net inside trust boundary; unpinned ollama (HIGH) | `core.compose.yml:44-53`; `assistant/entrypoint.sh:281`; `services.compose.yml` | S.6 |
| rev10-F5 security half / CLAUDE.md fictional pipeline | `CLAUDE.md:242` | S.7 |
| rev3-F7 stale HMAC/nonce/replay comments | `proxy.ts:170-171,311,418`; `oc-bounds.ts:38,74` | S.7 |
| rev8-D2–D4 port-table drift + security-pass extras (3820/3821→8182; voice 8880; 8080 correct) | `portals.compose.yml:129-132` | S.7 |
| rev8-D7 mount contract / invariant 3 | compose mounts | S.7 |
| rev8-D12 / D18 / D21 / D22 | respective doc sections | S.7 |
| rev8 `OP_ALLOW_REMOTE_SETUP` "impossible" claim | `core-principles.md` | S.7 |
| rev3-F4 `x-openpalm-user` trusted by construction | `auth.ts:90` | S.7 (document, don't "fix") |
| rev3-F2 heuristic-table gaps | `content-screen.ts` | S.8 |
| rev3-F5 rewrite spreads non-`parts` fields | rewrite path | S.8 |
| rev3-F8 global frames fan out | event streaming | S.8 |
| rev3-F6 dead `GUARDIAN_REQUIRE_PORTAL_SECRETS` | `portals.compose.yml:114` | Part A 3.5 (behavior-neutral deletion; cross-ref) |
| rev6-F6 secret-handling implications (auth.json dir delete) | `secrets.ts:165-172` | Part A 0.4 (cross-ref) |
| X14 secret-strip value loss (security-reviewed, data-loss fix) | `config-persistence.ts:96-138` | Part A 0.1 (cross-ref) |
| rev10-F2 auth-test gaps (proxy negative case; untested login route) | `server.vitest.ts` scope; `/admin/auth/login` | Part A 3.4 (cross-ref) |

*Plan authored 2026-07-05 against `main@002b715b`. Defensive hardening of first-party
infrastructure; changes no source code itself. Requires sign-off on decisions D1–D4 (§0.3)
before implementation. Companion to `fable-remediation-plan.md` (Part A).*
