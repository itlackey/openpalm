# Fix spec — c11-assistant-auth-health (PR #564 P1-1, P1-2)

_Re-authored by the opus fix-spec author (workflow handoff 0602b91 — Fable credits
exhausted). Verified against current HEAD of `claude/0-13-0-milestone-plan-27cr2y`.
Every cited line re-read against the live tree; the pre-fix defect state was
reproduced from git history; the two verification gates were executed in this
environment._

Severity: BLOCKER (deploy-blocker, from PR #564 manual test notes
`PR-564-MANUAL-TEST-NOTES.md`; reviewer-confirmed on 3825e005).

Root cause: OpenCode enables HTTP Basic auth whenever a non-empty
`OPENCODE_SERVER_PASSWORD` reaches its environment, and the assistant healthcheck
probed `/health` **without** credentials. The two findings are two halves of one
broken invariant. The fix makes **auth-enablement, password export, and the
health probe mutually consistent, keyed on the single operator knob
`OPENCODE_AUTH`.**

---

## 0. STATUS AT HEAD — already implemented; this spec ratifies + verifies

Both findings were **confirmed real** and are **already fixed on this branch**.
The full test-first → fix sequence landed in three commits after this cluster's
brief was filed:

| Commit | Role |
|---|---|
| `f91997e` | Prior fix spec (Fable) — superseded by this file |
| `5599308` | Red-first tests (P1-1/P1-2), verified failing against pre-fix product code |
| `c846151` | Product fix — entrypoint auth-gate + authenticated compose/Dockerfile healthchecks |

I re-derived the defect independently rather than trusting the commit log:

- **P1-2 pre-fix proof.** `git show c846151^:containers/assistant/entrypoint.sh`
  shows `resolve_opencode_server_password` reading and exporting the secret file
  with **no `opencode_auth_enabled` gate** on the read/export branch (the gate
  existed only on the fail-fast). That is exactly the reviewer's finding.
- **Current HEAD** (entrypoint.sh:165-178) opens the function with
  `if ! opencode_auth_enabled; then return 0; fi` — the export branch is now
  gated; the fail-fast still fires when auth is on and no password resolves.
- **P1-1 current HEAD** (core.compose.yml:187-198) gates the `/health` probe on
  a container-side `case "$${OPENCODE_AUTH:-false}"` and sends
  `curl -sf -u "$${OPENCODE_SERVER_USERNAME:-opencode}:$$(cat …)"` when truthy;
  plain probe otherwise. The Dockerfile mirror (D3) is applied at
  Dockerfile:258 with the H3 comment updated.

The rest of this document is the implementation-ready spec **as if fixing from
scratch** (so a revert can be re-applied verbatim), with each section noting the
landed state. No product file is to be changed by acting on this spec — the fix
is already present and green. The implementer's job for this cluster is to
**verify the gates in §5 stay green and not regress the landed work.**

---

## 1. Finding confirmation

### P1-1 — `packages/skeleton/system/stack/core.compose.yml` (assistant healthcheck) — CONFIRMED REAL (fixed)

Pre-fix probe was `curl -sf http://localhost:4096/health || exit 1; …` with no
credentials. Under the `home-password` preset the network-preset writer sets
`OPENCODE_AUTH: "true"` plus the operator password secret; the entrypoint
exports the password; OpenCode serves Basic auth; the unauthenticated `/health`
probe 401s; `curl -f` fails; the assistant never reports healthy; guardian's
`depends_on: assistant: condition: service_healthy`
(`portals.compose.yml`) blocks, and both portal services gate on guardian
health — the entire hardened-LAN stack cannot deploy. Reproduced live in
`PR-564-MANUAL-TEST-NOTES.md` (§ "Network preset authentication … Failed") on
3825e005.

Key constraint: a Docker healthcheck process receives the container's
**created** env (compose `environment:` map), **not** variables the entrypoint
exports later. The probe can therefore see `OPENCODE_AUTH` and
`OPENCODE_SERVER_PASSWORD_FILE` (core.compose.yml:57,61) but can **never** see
the entrypoint-exported `OPENCODE_SERVER_PASSWORD`. The probe must read the
mounted secret file itself — which the landed fix does.

### P1-2 — `containers/assistant/entrypoint.sh` `resolve_opencode_server_password` — CONFIRMED REAL (fixed)

Pre-fix (`c846151^`), the function read the file into
`OPENCODE_SERVER_PASSWORD` whenever the env var was empty and the file non-empty
(`[ -s "$OPENCODE_SERVER_PASSWORD_FILE" ]`) with **no `opencode_auth_enabled`
gate**. Only the fail-fast branch was gated.

The blast radius is wider than "after leaving home-password" — a non-empty
secret file with `OPENCODE_AUTH=false` is the **designed steady state**:

- `ensureSecrets` **always** materializes `op_opencode_password`, seeding a
  random value when missing and re-seeding a 0-byte file
  (`packages/lib/src/control-plane/secrets.ts`). Its own contract is that the
  seed is *inert while `OPENCODE_AUTH=false` (the default)*.
- `docs/technical/environment-and-mounts.md` documents the same intent (the
  secret is *always granted … inert while auth is off*).
- Switching a preset away from home-password writes `OPENCODE_AUTH: "false"`
  but deliberately leaves the old password in the secret file; emptying it by
  hand doesn't stick because the next lifecycle run re-seeds it randomly.

So pre-fix, **any real install/update that runs `ensureSecrets` followed by a
container restart exported a (random or stale) password, turned Basic auth on
while the operator's posture said off, and wedged the stack unhealthy behind the
unauthenticated probe.** CI's rootless smoke masked this only because its
fixture hand-builds `OP_HOME` with an *empty* secret file and never runs
`ensureSecrets`. Reproduced live in `PR-564-MANUAL-TEST-NOTES.md`
(§ "Preset transition … Failed").

Neither finding was fixed by the earlier branch commits the brief names:
`28d1afb` only seeded the smoke secret; `3825e00` touched the host-UI username
default and shared-guardian deploy.

---

## 2. Decided fix approach (as landed)

### D1 (P1-2, entrypoint): gate the file read/export on `opencode_auth_enabled`

Early-return from `resolve_opencode_server_password` when auth is off, **before
any file read or export**. Keep the env-wins-then-file resolution and the
fail-fast unchanged when auth is on.

**Decided against** `unset OPENCODE_SERVER_PASSWORD` when auth is off: an
*explicit* env password (bare `docker run -e …`, outside the managed stack —
inside it `secret-audit` forbids `*_PASSWORD` compose env keys) is an operator's
deliberate act, and silently unsetting it would *downgrade* auth on a possibly
LAN-exposed assistant. Fail-closed means never silently dropping credentials;
with D2 that inconsistent config fails **loud** (posture-gated probe 401s)
instead of silently flipping either way. A green-on-arrival pin locks this in.

**Decided against** "empty the secret on preset switch" as the primary fix:
`ensureSecrets` re-seeds 0-byte files by design and the file is referenced
unconditionally by both compose `secrets:` grants — the design intent is that
the *flag*, not file emptiness, controls auth. The entrypoint must honor that.

### D2 (P1-1, compose healthcheck): authenticate the probe iff `OPENCODE_AUTH` is truthy

Gate on the container-side `OPENCODE_AUTH` value with **exactly the entrypoint's
truthy set** (`true|TRUE|True|1|yes|YES`, entrypoint.sh:143-148) so probe and
server can never disagree about the posture. When truthy, probe with
`curl -sf -u "<user>:<file-content>"`; otherwise probe plain as today.

- **Username:** `$${OPENCODE_SERVER_USERNAME:-opencode}` (container-shell
  expansion). Nothing in the managed stack sets that var, so it resolves to
  OpenCode's own default `opencode` — the same literal the guardian uses and
  clusters c1/c2 standardize on. An overlay that injects a custom username into
  the assistant env is followed automatically.
- **Password:** `$$(cat "$${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")`
  — reads the same file the entrypoint reads, via the same env var compose sets,
  with the mounted-secret literal as fallback. `$(cat …)` strips exactly the
  trailing newline command substitution strips in the entrypoint, so probe and
  server agree byte-for-byte (also neutral to c2's whitespace decision — both
  readers use identical semantics).
- All container-side `$` are compose-escaped as `$$` (including `$$(cat …)`; a
  single `$(` is an invalid compose interpolation), the established idiom of
  this line (`$${OP_CLIENT_PORT:-3000}`).
- The client-port probe and `/tmp/openpalm-client-skip` exemption are preserved
  byte-identical.

**Decided against** "always send credentials whenever the file is non-empty" (no
`OPENCODE_AUTH` gate): simpler string, but it makes health report OK even when
auth is unexpectedly ON while the operator set `OPENCODE_AUTH=false` — i.e. it
would *mask* any regression of D1, while the guardian attaches no upstream
credentials and every portal call 401s under a "healthy" stack. Gating on the
requested posture keeps health meaning "the stack matches what you asked for,"
failing loud on drift. This is also the reviewer's prescribed shape.

### D3 (P1-1 mirror): apply the same gate to the image healthcheck

`containers/assistant/Dockerfile` carries the identical defect for image-only
(`docker run`) use, and its own H3 comment declares it *mirrors
core.compose.yml's own healthcheck exactly* — changing only the compose side
would break that documented invariant. The one deliberate scope extension beyond
the cited lines, justified by the repo's own mirror contract; same defect at the
mirror site, not a drive-by.

The Dockerfile variant uses native single-`$` expansion and **adds env-password
precedence** —
`${OPENCODE_SERVER_PASSWORD:-$(cat "${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")}` —
because a bare `docker run` may supply the password as raw env with no secret
file mounted, and healthcheck processes *do* see created-env vars. This mirrors
the entrypoint's own precedence. The compose variant deliberately omits the
raw-env branch: inside the managed stack that state is impossible (secret-audit
rejects `*_PASSWORD` compose env keys), and dead guards in an already-long
`CMD-SHELL` are unjustified complexity.

---

## 3. TEST-FIRST PLAN (landed in `5599308`; RED before the fix, GREEN after)

All tests live in `packages/lib` and reuse the file's existing harnesses — no
new fixtures, no new dependencies. Run with:
`cd packages/lib && bun test src/control-plane/assistant-client-entrypoint.test.ts src/control-plane/assistant-client-compose.test.ts`

### 3a. `assistant-client-entrypoint.test.ts`

Behavioral tests use the existing `runResolvePasswordScenario` driver (sources
only the function definitions, invokes `resolve_opencode_server_password`,
reports `SET:<value>` / `UNSET` on stdout). Inside
`describe('#563 — resolve_opencode_server_password (behavioral)')`:

1. **RE-SCOPE T34** → `'T34: exports the file contents with the trailing newline
   stripped when OPENCODE_AUTH is enabled'`, scenario gains `OPENCODE_AUTH: 'true'`.
   Old T34 (auth unset + non-empty file → exported) was itself a pin of the P1-2
   bug; the re-scope keeps the valid half (newline-strip via export path) pinned
   under the posture where export *should* happen. GREEN before and after — a
   re-scope, not a red test.
2. **NEW `'P1-2: OPENCODE_AUTH=false ignores a stale non-empty password file —
   variable stays unset'`** — `{ OPENCODE_AUTH: 'false', OPENCODE_SERVER_PASSWORD_FILE }`,
   file `'stale-pw\n'`; assert `exitCode === 0`, `stdout.trim() === 'UNSET'`.
   RED pre-fix (observed `SET:stale-pw`).
3. **NEW `'P1-2: auth unset (shipped default posture) ignores a non-empty
   password file'`** — `{ OPENCODE_SERVER_PASSWORD_FILE }` only; same asserts.
   RED pre-fix (this is old T34's scenario, now asserting the correct outcome).
   Separate from (2) because `unset` and `false` exercise the two
   `${OPENCODE_AUTH:-false}` default paths.
4. **NEW pin (green-on-arrival) `'P1-2 guard: an explicit OPENCODE_SERVER_PASSWORD
   env value is preserved, never unset, when auth is off'`** —
   `{ OPENCODE_AUTH: 'false', OPENCODE_SERVER_PASSWORD: 'envpass' }`; assert
   `SET:envpass`. Pins decision D1's no-unset rule so no future "helpful" fix can
   downgrade auth silently.

   (T35/T36 untouched, stay green. The fail-fast substrings `OPENCODE_AUTH` /
   `OPENCODE_SERVER_PASSWORD_FILE` are pinned by T35 — the error line must not be
   reworded.)

Static Dockerfile test in `describe('P5d assistant Dockerfile (static-only)')`
(uses the module-level `dockerfile` string):

5. **NEW `'H3 mirror: the image HEALTHCHECK authenticates the /health probe when
   OPENCODE_AUTH is truthy (P1-1)'`** —
   ```ts
   expect(dockerfile).toContain('case "${OPENCODE_AUTH:-false}"');
   expect(dockerfile).toContain('true|TRUE|True|1|yes|YES');
   expect(dockerfile).toContain('-u "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD:-$(cat');
   expect(dockerfile).toContain('openpalm-client-skip');
   ```
   RED pre-fix (HEALTHCHECK had no `case`, no `-u`).

### 3b. `assistant-client-compose.test.ts`

Extend the local `ComposeService` type with `healthcheck?: { test?: unknown };`
(the existing I2 block already accessed `assistant?.healthcheck?.test` untyped;
the new tests make that load-bearing). New
`describe('P1-1 (#564 c11) — assistant healthcheck authenticates when
OPENCODE_AUTH is truthy')`, reusing the I2 idiom
`const healthcheckTest = String(assistant?.healthcheck?.test ?? [])`:

6. **NEW static** `'the OpenCode probe gates on container-side OPENCODE_AUTH and
   sends Basic credentials when truthy'` —
   `toContain('case "$${OPENCODE_AUTH:-false}"')`,
   `toContain('true|TRUE|True|1|yes|YES')`,
   `toContain('curl -sf -u "$${OPENCODE_SERVER_USERNAME:-opencode}:')`.
   RED pre-fix.
7. **NEW static** `'the authenticated probe reads the secret file container-side
   — no host-interpolated auth fragment'` — positive `toContain('$$(cat')`,
   `toContain('opencode_server_password')`; negative (mirror the I2
   `hostInterpolatedReference` idiom): for each of `OPENCODE_AUTH`,
   `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD_FILE`,
   `not.toMatch(new RegExp('(^|[^$])\\$\\{' + name + '\\b'))`, and
   `not.toMatch(/(^|[^$])\$\(cat/)` (a single-`$` `$(cat` is host-side and an
   invalid compose interpolation). RED pre-fix on the positive asserts.
8. **NEW pin (green-on-arrival)** `'the auth-off branch still probes /health
   plain (default posture unchanged)'` —
   `toContain('curl -sf http://localhost:4096/health')`. Pins the `*)` branch
   byte-stable.
9. **NEW behavioral** `'behavioral: the interpolated probe sends Basic
   credentials exactly when OPENCODE_AUTH is truthy'` — static greps can't catch
   quoting/folding mistakes, so execute the probe: extract element `[1]` of the
   test list; simulate compose interpolation with `probe.replaceAll('$$', '$')`
   (string contains only `$$` escapes — proven by test 7's negatives);
   hermeticize the skip marker via
   `.replaceAll('/tmp/openpalm-client-skip', join(tempDir, 'client-skip'))`;
   write a stub `curl` into `join(tempDir,'bin')` that appends argv to `CURL_LOG`
   and exits 0; `spawnSync('sh', ['-c', interpolated], { env: {PATH, CURL_LOG,
   ...scenario} })`. Scenario A
   `{ OPENCODE_AUTH:'true', OPENCODE_SERVER_PASSWORD_FILE }` (file `'hc-pass\n'`)
   → exit 0 and first curl line contains `-u opencode:hc-pass` + `/health`
   (newline stripped, default username). Scenario B `{}` → exit 0 and the
   `/health` curl line has no `-u`. RED pre-fix (scenario A logs no `-u`).

The four existing I2 healthcheck tests must remain green against the shipped
YAML.

### Genuinely untestable here

End-to-end "container flips to healthy under home-password" needs a Docker
daemon (none in dev/CI). The honest floor: behavioral probe execution (test 9),
behavioral entrypoint gating (tests 2-4), static pins (5-8), plus `bash -n`
(pinned by the existing characterization test). Post-merge, re-run the two
failed scenarios from `PR-564-MANUAL-TEST-NOTES.md` (§ "Network preset
authentication", § "Preset transition") on a Docker host to close the loop.

---

## 4. File-level changes (product code — as landed in `c846151`)

### 4.1 `containers/assistant/entrypoint.sh` (P1-2) — DONE

`resolve_opencode_server_password` (lines 165-178) now opens with:

```bash
resolve_opencode_server_password() {
  if ! opencode_auth_enabled; then
    return 0
  fi
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ] \
     && [ -n "${OPENCODE_SERVER_PASSWORD_FILE:-}" ] && [ -s "${OPENCODE_SERVER_PASSWORD_FILE}" ]; then
    OPENCODE_SERVER_PASSWORD="$(cat "${OPENCODE_SERVER_PASSWORD_FILE}")"
    export OPENCODE_SERVER_PASSWORD
  fi
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    echo "ERROR: OPENCODE_AUTH=${OPENCODE_AUTH:-} is enabled but no password is available — set OPENCODE_SERVER_PASSWORD or OPENCODE_SERVER_PASSWORD_FILE (compose secret opencode_server_password)." >&2
    exit 1
  fi
}
```

- Error line is byte-identical to the pre-fix line (T35 pins its substrings).
- The final guard dropped the now-redundant `opencode_auth_enabled &&` (the early
  return already established it).
- The leading comment (lines 150-164) documents the #564 P1-2 gate, decision D1
  (explicit env value never unset), and the retained #563 semantics.
- Boot-sequence order is correct: `resolve_opencode_server_password` (line 619)
  runs before `start_client`/`start_opencode`.

### 4.2 `packages/skeleton/system/stack/core.compose.yml` (P1-1) — DONE

The `healthcheck:` block (lines 187-202) is:

```yaml
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          case "$${OPENCODE_AUTH:-false}" in
          true|TRUE|True|1|yes|YES)
          curl -sf -u "$${OPENCODE_SERVER_USERNAME:-opencode}:$$(cat "$${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")"
          http://localhost:4096/health || exit 1 ;;
          *)
          curl -sf http://localhost:4096/health || exit 1 ;;
          esac;
          if [ ! -f /tmp/openpalm-client-skip ]; then curl -sf http://localhost:$${OP_CLIENT_PORT:-3000}/ >/dev/null || exit 1; fi
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s
```

- `>-` folded scalar, no blank lines, every container-side `$` escaped as `$$`
  (including `$$(cat …)`). `interval/timeout/retries/start_period` unchanged.
- The long comment above the block (lines 171-186) documents the #564 P1-1 gate,
  the truthy-set mirror, the username default, the file-read rationale (healthcheck
  processes never see entrypoint-exported env), and the posture-gate rationale
  (stale-secret regression fails loud, not masked).

### 4.3 `containers/assistant/Dockerfile` (P1-1 mirror, D3) — DONE

HEALTHCHECK (line 258) now gates on `case "${OPENCODE_AUTH:-false}"` with the
env-then-file password precedence
`${OPENCODE_SERVER_PASSWORD:-$(cat "${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")}`,
`esac && { [ -f /tmp/openpalm-client-skip ] || curl … ; }` preserving the client
probe chain. Options line unchanged. The H3 comment (lines ~248-257) documents
the mirror and the raw-env-branch rationale (bare `docker run`).

### 4.4 Test files — DONE

Per §3, in `assistant-client-entrypoint.test.ts` (re-scope T34; add tests 2-5)
and `assistant-client-compose.test.ts` (extend `ComposeService`; add tests 6-9).
Biome style (single quotes, trailing commas, 2-space), RED/pin comments,
`bun:test` imports already present. No docs or other files changed.

---

## 5. Verification gates (run green in this environment)

1. **`bun run lint`** — GREEN. Biome checked 921 files, no fixes applied; 12
   pre-existing warnings + 1 info, none in c11's touched files.
2. **`cd packages/guardian && bun test --no-orphans`** — 332 pass / **1 fail**.
   The single failure is the **pre-existing `getAvailablePort` port-allocation
   flake** in `src/server-moderation.test.ts:19` — an environmental race, not a
   regression: c11 touches **no** guardian source, and the prior spec already
   flagged this exact flake. Re-run to confirm it is not deterministic; do not
   chase it here. The #563 upstream-auth suite (`upstream-auth.test.ts`) passes,
   proving no regression of the guardian side of home-password.
3. **`cd packages/lib && bun test src/control-plane/assistant-client-entrypoint.test.ts src/control-plane/assistant-client-compose.test.ts`**
   — **68 pass / 0 fail**, 174 expect() calls. All §3 tests green; the
   pre-existing I2/F4/H3/E1/I5 pins stay green.
4. Optional: `bun run lib:test` — full lib suite. Known caveat
   (`PR-564-MANUAL-TEST-NOTES.md` § "Verification Gaps"): three assistant
   *supervisor* tests have a process-cleanup race unrelated to this cluster; if
   one flakes, re-run.
5. **Statement of limitation:** no Docker daemon here — full stack health
   (home-password deploy → assistant healthy → guardian deploys; preset
   transition → healthy) must be re-verified on a Docker host per the manual
   runbook scenarios.

Prior-finding regression check: the fix does not alter `28d1afb` (smoke secret
seeding — the empty-file fixture stays valid: empty file + auth off → early
return, plain probe) or `3825e00` (host-UI `opencode` username default — those
files untouched).

---

## 6. Out of scope / non-goals / coordination

- **c1 (host UI username fallbacks) / c2 (guardian `OPENCODE_SERVER_USERNAME`
  honor + password whitespace):** untouched here. **Coordination:** the shared
  username default is the literal `opencode` (OpenCode's own default) — c11's
  probes encode it as the container-shell fallback
  `${OPENCODE_SERVER_USERNAME:-opencode}`; guardian/host UI keep their own local
  `'opencode'` literals per the lib/guardian package boundary (no forced
  cross-package sharing; a shell probe cannot import a constant anyway). c11 is
  whitespace-neutral: the probe's `$(cat …)` matches the entrypoint's `$(cat …)`
  byte-for-byte, so whichever normalization c2 lands stays consistent.
- **No new compose env plumbing** for `OPENCODE_SERVER_USERNAME` (no preset sets
  it; the probe honors overlay-injected env) and no change to
  `OPENCODE_AUTH`/secret plumbing pinned by the network-partitioning tests.
- **No change** to `ensureSecrets`' always-materialize/re-seed design — the
  entrypoint now honors its documented "inert while auth is off" contract.
- **No change** to guardian's own `/health/ready` healthcheck — the guardian
  gateway does not Basic-auth its own health endpoint; unrelated surface.
- **Not fixing here:** P2-1 (mDNS ingress gate — c12), P2-2 (pairing IDs — c8),
  P3-* items, and the pre-existing guardian port-alloc flake /
  supervisor-cleanup race in the manual-notes Verification Gaps.
- **Security posture:** unchanged by default — `OPENCODE_AUTH` stays off,
  loopback binds untouched, no secret value is ever logged (the probe reads the
  file inside the container only; `docker inspect` shows the unexpanded command
  string, never the resolved password), fail-closed strengthened (auth-on with
  no password still hard-fails the entrypoint; posture drift now fails the
  healthcheck loudly).
