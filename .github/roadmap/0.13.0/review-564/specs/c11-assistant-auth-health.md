# Fix spec — c11-assistant-auth-health (PR #564 P1-1, P1-2)

_Verified against HEAD `b4de6b2` (branch already carries 28d1afb, 3825e00). Spec author re-confirmed every cited line against the current tree; all mechanics below (shell, YAML, compose interpolation) were executed in a sandbox before being prescribed._

Severity: BLOCKER. Root cause: OpenCode enables Basic auth whenever a non-empty
`OPENCODE_SERVER_PASSWORD` reaches its environment, and the assistant healthcheck
probes `/health` unauthenticated. The two findings are two halves of one broken
invariant — the fix makes **auth-enablement, password export, and the health
probe mutually consistent, keyed on the single operator knob `OPENCODE_AUTH`**.

---

## 1. Finding confirmation

### P1-1 — `packages/skeleton/system/stack/core.compose.yml:172` — CONFIRMED REAL

Current HEAD line 172:

```yaml
test: [ "CMD-SHELL", "curl -sf http://localhost:4096/health || exit 1; if [ ! -f /tmp/openpalm-client-skip ]; then curl -sf http://localhost:$${OP_CLIENT_PORT:-3000}/ >/dev/null || exit 1; fi" ]
```

No credentials anywhere in the probe. Under the `home-password` preset,
`resolveNetworkPreset` writes `OPENCODE_AUTH: "true"` + the operator password
(`packages/lib/src/control-plane/network-preset.ts:128-135`), the entrypoint
exports the password, OpenCode serves Basic auth, and the unauthenticated
`/health` probe 401s. `curl -f` fails on 401 → assistant never becomes healthy →
guardian's `depends_on: assistant: condition: service_healthy`
(`packages/skeleton/system/stack/portals.compose.yml:194-196`) blocks the
guardian, and both portal services gate on guardian health (`portals.compose.yml:40-42,74-76`)
— the entire hardened-LAN stack cannot deploy. Reproduced live in
`PR-564-MANUAL-TEST-NOTES.md` ("Network preset authentication … Failed") on 3825e005.

Note: a Docker healthcheck process receives the container's **created** env
(compose `environment:` map), *not* variables the entrypoint exports later — so
the probe can see `OPENCODE_AUTH` / `OPENCODE_SERVER_PASSWORD_FILE`
(core.compose.yml:57,61) but can never see the entrypoint-exported
`OPENCODE_SERVER_PASSWORD`. The probe must therefore read the mounted secret
file itself, exactly as the reviewer prescribes.

### P1-2 — `containers/assistant/entrypoint.sh:150-165` — CONFIRMED REAL

Current HEAD `resolve_opencode_server_password` (lines 155-165) reads the file
into `OPENCODE_SERVER_PASSWORD` whenever the env var is empty and the file is
non-empty (`[ -s "$OPENCODE_SERVER_PASSWORD_FILE" ]`) — with **no
`opencode_auth_enabled` gate**. Only the fail-fast branch is gated.

The blast radius is wider than "after leaving home-password", because a
non-empty secret file with `OPENCODE_AUTH=false` is the **designed steady
state**, not an anomaly:

- `ensureSecrets` **always** materializes `op_opencode_password`, seeding a
  random value when missing and even re-seeding a 0-byte file
  (`packages/lib/src/control-plane/secrets.ts:161-168`,
  `secrets-files.ts:47-58`). Its own comment states the intended contract the
  entrypoint violates: *"the random seed is inert while OPENCODE_AUTH=false
  (the default)"*.
- `docs/technical/environment-and-mounts.md:118` documents the same intent:
  the secret is *"always granted (… inert while auth is off)"*.
- Switching preset away from home-password writes `OPENCODE_AUTH: "false"`
  (`network-preset.ts:93-99` `ALL_LOOPBACK`) but deliberately leaves the secret
  file's old password in place — and emptying it by hand doesn't stick, since
  the next lifecycle run re-seeds it randomly.

So on the current code, **any real install/update that runs `ensureSecrets`
followed by a container restart exports a (random or stale) password and turns
Basic auth on while the operator's posture says off**, and the unauthenticated
probe wedges the stack unhealthy. (CI's rootless smoke masks this only because
its fixture hand-builds OP_HOME with an *empty* secret file,
`scripts/rootless-smoke-fixture.sh:49-52`, and never runs `ensureSecrets`.)
Reproduced live in `PR-564-MANUAL-TEST-NOTES.md` ("Preset transition … Failed").

Neither finding is already fixed on this branch: 28d1afb only seeded the smoke
secret; 3825e00 touched the host-UI username default and shared-guardian deploy.

---

## 2. Decided fix approach

### D1 (P1-2, entrypoint): gate the file read/export on `opencode_auth_enabled`

Early-return from `resolve_opencode_server_password` when auth is off, **before
any file read or export**. Keep the env-wins-then-file resolution and the
fail-fast unchanged when auth is on.

**Decided against** the alternative of `unset OPENCODE_SERVER_PASSWORD` when
auth is off: an *explicit* env password (bare `docker run -e …`, outside the
managed stack — inside it, `secret-audit` forbids `*_PASSWORD` compose env
keys) is an operator's deliberate act, and silently unsetting it would
*downgrade* auth on a possibly LAN-exposed assistant. Fail-closed means never
silently dropping credentials; with D2 below, that inconsistent configuration
fails **loud** (posture-gated probe 401s) instead of silently flipping either
way. A pinning test locks this decision in.

**Decided against** "empty the secret on preset switch" as the primary fix:
`ensureSecret` re-seeds 0-byte files by design, and the file is referenced
unconditionally by both compose `secrets:` grants — the design intent
(secrets.ts:161-167) is that the *flag*, not file emptiness, controls auth.
The entrypoint must honor that contract.

### D2 (P1-1, compose healthcheck): authenticate the probe iff `OPENCODE_AUTH` is truthy

Gate on the container-side `OPENCODE_AUTH` value with **exactly the entrypoint's
truthy set** (`true|TRUE|True|1|yes|YES`, entrypoint.sh:143-148) so probe and
server can never disagree about the posture. When truthy, probe with
`curl -sf -u "<user>:<file-content>"`; otherwise probe plain as today.

- **Username:** `$${OPENCODE_SERVER_USERNAME:-opencode}` (container-shell
  expansion). Nothing in the managed stack sets that env var, so it resolves to
  OpenCode's own default `opencode` — the same literal the guardian uses
  (`packages/guardian/src/config.ts:156`) and clusters c1/c2 are standardizing
  on. If an operator overlay injects a custom username into the assistant env
  (which changes what OpenCode expects), the probe follows automatically.
- **Password:** `$$(cat "$${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")`
  — reads the same file the entrypoint reads, via the same env var compose sets
  at core.compose.yml:61, with the mounted-secret literal as fallback. `$(cat …)`
  strips exactly the trailing newline(s) command substitution strips in the
  entrypoint (entrypoint.sh:158), so probe and server always agree on the value
  byte-for-byte (this also stays neutral to c2's whitespace decision — both
  readers use identical semantics).
- All container-side `$` are compose-escaped as `$$` (including `$$(cat …)` —
  a single `$(` is an invalid compose interpolation), the established idiom of
  this exact line (`$${OP_CLIENT_PORT:-3000}`).
- The client-port probe and `/tmp/openpalm-client-skip` exemption are preserved
  byte-identical.

**Decided against** "always send credentials whenever the secret file is
non-empty" (no `OPENCODE_AUTH` gate): it would be a *simpler* string, but it
makes health report "OK" even when auth is unexpectedly ON while the operator
set `OPENCODE_AUTH=false` (i.e. it would *mask* any regression of D1) — in that
state the guardian attaches no upstream credentials
(`resolveAssistantUpstreamAuth` returns `null`, config.ts:131) and every portal
call 401s while the stack looks healthy. Gating on the operator-requested
posture keeps health meaning "the stack matches what you asked for", failing
loud on drift. This is also the reviewer's prescribed shape.

### D3 (P1-1 mirror): apply the same gate to the image healthcheck

`containers/assistant/Dockerfile:246-247` carries the identical defect for
image-only (`docker run`) use, and its own H3 comment (lines 237-245) declares
it *"mirrors core.compose.yml's own healthcheck exactly"* — changing only the
compose side would break that documented invariant. This is the one deliberate
scope extension beyond the cited lines, justified by the repo's own
mirror contract; it is the same defect at the mirror site, not a drive-by.

The Dockerfile variant uses native single-`$` expansion and adds env-password
precedence — `${OPENCODE_SERVER_PASSWORD:-$(cat "${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")}` —
because a bare `docker run` may supply the password as raw env with no secret
file mounted, and healthcheck processes *do* see created-env vars. This mirrors
the entrypoint's own precedence (env wins, file fallback). The compose variant
deliberately omits the raw-env branch: inside the managed stack that state is
impossible (secret-audit rejects `*_PASSWORD` compose env keys), and dead
guards in an already-long CMD-SHELL are unjustified complexity.

---

## 3. TEST-FIRST PLAN (write these before touching any product file; run them RED)

All tests live in `packages/lib` and reuse the file's existing harnesses —
no new fixtures, no new dependencies. Run with:
`cd packages/lib && bun test src/control-plane/assistant-client-entrypoint.test.ts src/control-plane/assistant-client-compose.test.ts`

### 3a. `packages/lib/src/control-plane/assistant-client-entrypoint.test.ts`

Behavioral tests using the existing `runResolvePasswordScenario` driver
(lines 799-834; sources only function definitions, invokes
`resolve_opencode_server_password`, reports `SET:<value>` / `UNSET` on stdout).
Add to the existing `describe('#563 — resolve_opencode_server_password (behavioral)')`:

1. **MODIFY T34** (line 837, currently
   `{ OPENCODE_SERVER_PASSWORD_FILE: pwFile }`): add `OPENCODE_AUTH: 'true'`
   to the scenario env and rename to
   `'T34: exports the file contents with the trailing newline stripped when OPENCODE_AUTH is enabled'`.
   *Why touched:* T34's current scenario (auth unset + non-empty file →
   exported) is a pin of the P1-2 defect itself. The modified test keeps the
   valid half (newline-strip via export path) pinned. GREEN before and after —
   this is a re-scope, not a red test; say so in the test comment.

2. **NEW** `'P1-2: OPENCODE_AUTH=false ignores a stale non-empty password file — variable stays unset'`
   — scenario `{ OPENCODE_AUTH: 'false', OPENCODE_SERVER_PASSWORD_FILE: pwFile }`
   (reuse T34's tmp-file pattern, content `'stale-pw\n'`). Assert
   `exitCode === 0` and `stdout.trim() === 'UNSET'`.
   **RED today:** current code exports whenever the file is non-empty →
   observed `SET:stale-pw`.

3. **NEW** `'P1-2: auth unset (shipped default posture) ignores a non-empty password file'`
   — scenario `{ OPENCODE_SERVER_PASSWORD_FILE: pwFile }` only. Assert
   `exitCode === 0`, `stdout.trim() === 'UNSET'`.
   **RED today** for the same reason (this is literally old T34's scenario,
   now asserting the correct outcome). Kept separate from (2) because `unset`
   and `false` exercise the two `${OPENCODE_AUTH:-false}` default paths.

4. **NEW (pin, green-on-arrival)** `'P1-2 guard: an explicit OPENCODE_SERVER_PASSWORD env value is preserved, never unset, when auth is off'`
   — scenario `{ OPENCODE_AUTH: 'false', OPENCODE_SERVER_PASSWORD: 'envpass' }`.
   Assert `exitCode === 0`, `stdout.trim() === 'SET:envpass'`.
   GREEN before and after; pins decision D1's no-unset rule so a future
   implementer cannot "helpfully" downgrade auth. Comment must state it is a pin.

   (T35/T36 are untouched and must stay green: the fail-fast message substrings
   `OPENCODE_AUTH` / `OPENCODE_SERVER_PASSWORD_FILE` are pinned by T35 — do not
   reword the error line.)

Static Dockerfile test, add to `describe('P5d assistant Dockerfile (static-only)')`
(line 373; uses the module-level `dockerfile` string):

5. **NEW** `'H3 mirror: the image HEALTHCHECK authenticates the /health probe when OPENCODE_AUTH is truthy (P1-1)'` —
   ```ts
   expect(dockerfile).toContain('case "${OPENCODE_AUTH:-false}"');
   expect(dockerfile).toContain('true|TRUE|True|1|yes|YES');
   expect(dockerfile).toContain('-u "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD:-$(cat');
   expect(dockerfile).toContain('openpalm-client-skip');
   ```
   **RED today:** the HEALTHCHECK (Dockerfile:247) contains no `case`, no `-u`.

### 3b. `packages/lib/src/control-plane/assistant-client-compose.test.ts`

Extend the `ComposeService` type (lines 23-27) with
`healthcheck?: { test?: unknown };` — the existing I2 block already accesses
`assistant?.healthcheck?.test` untyped; the new tests make that access
load-bearing, so type it. New `describe('P1-1 (#564 c11) — assistant healthcheck authenticates when OPENCODE_AUTH is truthy')`,
reusing the I2 idiom `const healthcheckTest = String(assistant?.healthcheck?.test ?? [])`:

6. **NEW (static)** `'the OpenCode probe gates on container-side OPENCODE_AUTH and sends Basic credentials when truthy'` —
   ```ts
   expect(healthcheckTest).toContain('case "$${OPENCODE_AUTH:-false}"');
   expect(healthcheckTest).toContain('true|TRUE|True|1|yes|YES');   // exact entrypoint truthy set
   expect(healthcheckTest).toContain('curl -sf -u "$${OPENCODE_SERVER_USERNAME:-opencode}:');
   ```
   **RED today:** the probe has no `case`, no `-u`, no username reference.

7. **NEW (static)** `'the authenticated probe reads the secret file container-side — no host-interpolated auth fragment'` —
   positive: `toContain('$$(cat')`, `toContain('opencode_server_password')`;
   negative (mirror the I2 `hostInterpolatedReference` idiom, lines 174-182):
   for each of `OPENCODE_AUTH`, `OPENCODE_SERVER_USERNAME`,
   `OPENCODE_SERVER_PASSWORD_FILE`, assert
   `not.toMatch(new RegExp('(^|[^$])\\$\\{' + name + '\\b'))`, and
   `not.toMatch(/(^|[^$])\$\(cat/)` (a single-`$` `$(cat` would be host-side —
   and an invalid compose interpolation to boot).
   **RED today** on the positive assertions.

8. **NEW (pin, green-on-arrival)** `'the auth-off branch still probes /health plain (default posture unchanged)'` —
   `expect(healthcheckTest).toContain('curl -sf http://localhost:4096/health')`.
   GREEN today (it is the only probe) and must stay green as the `*)` branch —
   pins that the default posture's probe is byte-stable. Comment as a pin.

9. **NEW (behavioral)** `'behavioral: the interpolated probe sends Basic credentials exactly when OPENCODE_AUTH is truthy'` —
   the static greps cannot catch quoting/folding mistakes, so execute the probe:
   - extract `const probe = String((assistant?.healthcheck?.test as unknown[])[1] ?? '')`;
   - simulate compose interpolation: `probe.replaceAll('$$', '$')` (the string
     contains only `$$` escapes — verified by test 7's negative assertions);
   - hermeticize the skip marker: `.replaceAll('/tmp/openpalm-client-skip', join(tempDir, 'client-skip'))`
     (same trick as FUNCTION_DRIVER's sed, assistant-client-entrypoint.test.ts:497);
   - write a stub `curl` into `join(tempDir, 'bin')` that appends its argv to
     `CURL_LOG` and exits 0 (mirror the DRIVER stubs, entrypoint test lines 53-87),
     `chmod 0o755`;
   - `spawnSync('sh', ['-c', interpolated], { env: { PATH: `${tempDir}/bin:${process.env.PATH}`, CURL_LOG, ...scenario } })`;
   - scenario A `{ OPENCODE_AUTH: 'true', OPENCODE_SERVER_PASSWORD_FILE: secretFile }`
     with `secretFile` containing `'hc-pass\n'`: assert exit 0 and the first
     logged curl line contains `-u opencode:hc-pass` and `/health` (newline
     stripped, default username);
   - scenario B `{}`: assert exit 0 and the `/health` curl line contains no `-u`.
   **RED today (scenario A):** no `-u` is ever logged.
   Spec author pre-validated this exact mechanic (yaml parse → `$$`→`$` →
   `sh -c` with stub curl) in a sandbox: auth-on logs
   `curl -sf -u opencode:hc-pass http://localhost:4096/health`, auth-off logs
   the plain probe, custom `OPENCODE_SERVER_USERNAME` is honored, failures
   propagate rc≠0.

The four existing I2 healthcheck tests (lines 142-186) must remain green —
they were verified to pass against the exact YAML prescribed in §4.2
(`String()` of the two-element list yields `'CMD-SHELL,case …'`).

### Genuinely untestable here

End-to-end "container flips to healthy under home-password" needs a Docker
daemon (none in dev/CI — the same documented limit as the file headers state).
The honest floor is: behavioral probe execution (test 9), behavioral entrypoint
gating (tests 2-4), static pins (5-8), plus `bash -n` (already pinned by the
existing characterization test at entrypoint test line 342). Post-merge, re-run
the two failed scenarios from `PR-564-MANUAL-TEST-NOTES.md` (§ "Network preset
authentication", § "Preset transition") on a Docker host to close the loop.

---

## 4. File-level changes (product code — after the tests above are red)

### 4.1 `containers/assistant/entrypoint.sh` (P1-2)

Replace the comment block + function at lines 150-165. Function body:

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

Notes:
- The error line is **byte-identical** to today's (T35 pins its substrings).
- The final guard drops the now-redundant `opencode_auth_enabled &&` (the
  early return already established it).
- Rewrite the leading comment (replacing lines 150-154) to state: (a) the
  #564 P1-2 gate — the secret file is ALWAYS materialized non-empty by
  `ensureSecrets` (random seed / stale preset password) and must stay inert
  while `OPENCODE_AUTH` is off, or OpenCode enables Basic auth against an
  unauthenticated healthcheck and wedges the stack; (b) the D1 decision — an
  explicit `OPENCODE_SERVER_PASSWORD` env value is deliberately never unset
  (no silent auth downgrade; the posture-gated healthcheck fails loud on the
  mismatch); (c) the retained #563 semantics (env wins, `*_FILE` fallback,
  trailing newline stripped, fail-fast when auth-on resolves nothing).
- No other function changes. Boot-sequence order (line 606) is already correct
  (`resolve_opencode_server_password` runs before `start_client`/`start_opencode`).

### 4.2 `packages/skeleton/system/stack/core.compose.yml` (P1-1)

Replace the `healthcheck:` block (lines 171-176) with:

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

Notes:
- `>-` folded scalar: every content line at the same indent, **no blank lines**
  (folding joins single newlines with spaces → one shell line; verified to
  parse to the intended single-line command and to satisfy all four existing
  I2 assertions).
- `interval/timeout/retries/start_period` unchanged.
- Every container-side `$` is `$$` (compose escape) — including `$$(cat …)`;
  a bare `$(` is an invalid compose interpolation and must not appear.
- Extend the long comment above the block (lines 147-170) with a short
  paragraph (keep the existing I2/OP_CLIENT_PORT text intact): the `/health`
  probe authenticates **iff** the container-side `OPENCODE_AUTH` is truthy
  (#564 P1-1) — OpenCode 401s unauthenticated probes under the home-password
  preset, and guardian's `depends_on: service_healthy` then blocks the whole
  stack; the gate mirrors the entrypoint's `opencode_auth_enabled` truthy set
  exactly, the username defaults to OpenCode's own `opencode` (overlay-injected
  `OPENCODE_SERVER_USERNAME` is honored), and the password is `cat`ed from the
  same `OPENCODE_SERVER_PASSWORD_FILE` the entrypoint reads (healthcheck
  processes never see entrypoint-exported env, so reading the file is the only
  correct source). Deliberately gated on the operator's requested posture, not
  on file non-emptiness, so a stale-secret regression fails loud instead of
  being masked.

### 4.3 `containers/assistant/Dockerfile` (P1-1 mirror, D3)

Replace the HEALTHCHECK CMD (lines 246-247) with:

```dockerfile
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD bash -c 'case "${OPENCODE_AUTH:-false}" in true|TRUE|True|1|yes|YES) curl -sf -u "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD:-$(cat "${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}")}" http://localhost:${OPENCODE_PORT:-4096}/health >/dev/null ;; *) curl -sf http://localhost:${OPENCODE_PORT:-4096}/health >/dev/null ;; esac && { [ -f /tmp/openpalm-client-skip ] || curl -sf http://localhost:${OP_CLIENT_PORT:-3000}/ >/dev/null; }' || exit 1
```

Notes:
- Options line unchanged. Native single-`$` (HEALTHCHECK CMD is not subject to
  Dockerfile build-time env replacement; the container shell expands it — the
  existing line already relies on this).
- Env-password precedence `${OPENCODE_SERVER_PASSWORD:-$(cat …)}` is the
  Dockerfile-only addition (see D3 rationale). `case`'s exit status is the last
  executed command's, so `esac && { … }` preserves the existing chain semantics
  (validated in sandbox: auth-on/env, env-over-file, file-fallback, default,
  failure-propagation, custom `OPENCODE_PORT` all behave).
- Extend the H3 comment (lines 232-245): the probe authenticates iff
  `OPENCODE_AUTH` is truthy, mirroring core.compose.yml (#564 P1-1); the raw
  env fallback exists here (and not in compose) because bare `docker run` may
  carry the password as env with no secret mounted, while the managed stack
  forbids raw `*_PASSWORD` env (secret-audit) — and healthchecks only ever see
  created-env, never entrypoint exports.

### 4.4 Test files

Per §3: `packages/lib/src/control-plane/assistant-client-entrypoint.test.ts`
(modify T34; add tests 2-5) and
`packages/lib/src/control-plane/assistant-client-compose.test.ts`
(extend `ComposeService` type; add tests 6-9). Match file idioms: Biome style
(single quotes, trailing commas, 2-space), comments explaining RED/pin status,
`bun:test` imports already present. No `.md`, docs, or other files change.

### Commit sequence (repo convention: red tests first, then fix — cf. cc2c738 → a1eec23)

1. `test(pr-564 c11): pin auth-gated password export + authenticated assistant healthcheck (red) (PR #564 P1-1/P1-2)`
2. `fix(stack): home-password health — gate OpenCode password export on OPENCODE_AUTH and authenticate the /health probe (PR #564 P1-1/P1-2)`

Never push; no tags; no PRs. Keep `git diff --check` clean (P3-2 was just
fixed in 27ddef5 — no trailing whitespace, single trailing newline).

---

## 5. Verification gates (all must be green)

1. `bun run lint`
2. `cd packages/guardian && bun test --no-orphans` — no guardian source is
   touched; this proves no regression of the #563 upstream-auth suite
   (`upstream-auth.test.ts`) or anything else.
3. `cd packages/lib && bun test src/control-plane/assistant-client-entrypoint.test.ts src/control-plane/assistant-client-compose.test.ts`
   — the §3 tests green (and the pre-existing 59 tests in these two files stay
   green; both files verified green at HEAD baseline in this environment).
4. `bun run lib:test` — full lib suite. Known caveat from
   PR-564-MANUAL-TEST-NOTES.md ("Verification Gaps"): three pre-existing
   assistant *supervisor* tests have a process-cleanup race unrelated to this
   cluster (did not reproduce in this environment). If one flakes, re-run; do
   not chase it here.
5. Statement of limitation: no Docker daemon here — full stack health
   (home-password deploy → assistant healthy → guardian deploys; preset
   transition → healthy) must be re-verified on a Docker host per the manual
   runbook scenarios in PR-564-MANUAL-TEST-NOTES.md.

Prior-finding regression check: the fixes must not alter 28d1afb (smoke secret
seeding — the empty-file fixture stays valid: empty file + auth off → early
return, plain probe) or 3825e00 (host-UI `opencode` username default — untouched
files). The existing I2/F4/H3/E1/I5 healthcheck/client pins all remain asserted
by their unchanged tests.

---

## 6. Out of scope / non-goals / coordination

- **c1 (host UI username fallbacks) and c2 (guardian `OPENCODE_SERVER_USERNAME`
  honor + password whitespace):** untouched here. **Coordination:** the shared
  username default is the literal `opencode` (OpenCode's own default) — c11's
  probes encode it as the container-shell fallback
  `${OPENCODE_SERVER_USERNAME:-opencode}`, guardian/host UI keep their own
  local `'opencode'` literals per the lib/guardian boundary rule (no forced
  sharing across packages; a shell probe cannot import a constant anyway).
  c11 is whitespace-neutral: the probe's `$(cat …)` matches the entrypoint's
  `$(cat …)` byte-for-byte, so whichever normalization c2 lands (validation-side
  rejection or read-side trim agreement) stays consistent.
- **No new compose env plumbing** for `OPENCODE_SERVER_USERNAME` (no preset
  sets it; the probe honors overlay-injected env if an operator adds it) and
  no change to `OPENCODE_AUTH`/secret plumbing pinned by T28-T30
  (`network-partitioning.test.ts`).
- **No change** to `ensureSecrets`' always-materialize/re-seed design
  (secrets.ts:161-168) — the entrypoint now honors its documented "inert while
  auth is off" contract instead of fighting it.
- **No change** to guardian's own `/health/ready` healthcheck
  (portals.compose.yml:198) — the guardian gateway does not Basic-auth its own
  health endpoint; unrelated surface.
- **Not fixing here:** P2-1 (mDNS ingress gate — c12), P2-2 (pairing IDs — c8),
  P3-* items, and the pre-existing guardian policy-test timeouts / supervisor
  cleanup race noted in the manual-notes Verification Gaps.
- **Security posture:** unchanged by default — `OPENCODE_AUTH` stays off,
  loopback binds untouched, no secret value is ever logged (the probe reads the
  file inside the container only; `docker inspect` shows the unexpanded command
  string, never the resolved password), fail-closed behavior strengthened
  (auth-on-without-password still hard-fails the entrypoint; posture drift now
  fails the healthcheck loudly).
