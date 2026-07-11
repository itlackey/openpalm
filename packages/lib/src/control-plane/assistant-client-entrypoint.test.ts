/**
 * P5d (#510 Slice A) — the assistant container serves `@openpalm/client`
 * instead of the full `@openpalm/ui` host app (plan §6.9 as-landed + Phase 5
 * item 4; docs/technical/ui-runtime-modes-plan.md).
 *
 * RED tests written BEFORE the implementation. Two kinds of test live here:
 *
 * 1. BEHAVIORAL (bash-driven): `install_runtime_artifacts` is executed in a
 *    sandboxed bash with npm/bun/node stubbed onto PATH, so the exact-pin
 *    version-resolution chain (OP_CLIENT_VERSION → PLATFORM_VERSION → hard
 *    error, §8 rule 1: never `latest`) is exercised for real, not grepped.
 *    The entrypoint's trailing boot sequence (bare function-name lines at
 *    column 0) is stripped before sourcing so only definitions load.
 *
 * 2. STATIC-ONLY (labeled): string/regex assertions over entrypoint.sh and
 *    the Dockerfile. No docker daemon exists in the dev/CI container, so the
 *    co-process cannot be booted here — static verification (`bash -n` +
 *    content asserts) is the honest limit, mirroring
 *    assistant-rootless-entrypoint.test.ts.
 *
 * Tests marked CHARACTERIZATION pass against the current tree and pin
 * landed behavior the P5d implementation must not regress.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_LOCKED_CONNECTION_ID,
  ASSISTANT_LOCKED_CONNECTION_LABEL,
} from './client-runtime-config.js';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const ENTRYPOINT_PATH = join(REPO_ROOT, 'containers/assistant/entrypoint.sh');
const entrypoint = readFileSync(ENTRYPOINT_PATH, 'utf8');
const dockerfile = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf8');

// ── Behavioral harness ───────────────────────────────────────────────────────
// Sources ONLY the function definitions from the entrypoint (top-level bare
// invocation lines — the boot sequence — are stripped; unindented bash
// keywords are preserved), stubs npm/bun/node to log-and-succeed (or fail on
// STUB_NPM_FAIL_PATTERN), then runs install_runtime_artifacts with a
// controlled environment.
const DRIVER = `#!/usr/bin/env bash
set -uo pipefail

ENTRYPOINT="$1"
WORK="$2"

mkdir -p "$WORK/bin"

cat > "$WORK/bin/npm" <<'STUB'
#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$NPM_LOG"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--prefix" ] && [ ! -d "$arg" ]; then
    echo "npm error missing prefix directory: $arg" >&2
    exit 13
  fi
  prev="$arg"
done
if [ -n "\${STUB_NPM_FAIL_PATTERN:-}" ] && [[ "$*" == *"\${STUB_NPM_FAIL_PATTERN}"* ]]; then
  echo "npm error simulated registry failure" >&2
  exit 1
fi
exit 0
STUB

cat > "$WORK/bin/bun" <<'STUB'
#!/usr/bin/env bash
printf 'bun %s\\n' "$*" >> "$NPM_LOG"
if [ -n "\${STUB_NPM_FAIL_PATTERN:-}" ] && [[ "$*" == *"\${STUB_NPM_FAIL_PATTERN}"* ]]; then
  echo "bun error simulated registry failure" >&2
  exit 1
fi
exit 0
STUB

cat > "$WORK/bin/node" <<'STUB'
#!/usr/bin/env bash
printf 'node %s\\n' "$*" >> "$NPM_LOG"
exit 0
STUB

chmod +x "$WORK/bin/npm" "$WORK/bin/bun" "$WORK/bin/node"
export PATH="$WORK/bin:$PATH"

# Strip the top-level boot-sequence invocations (bare function-name lines at
# column 0); keep unindented bash keywords so syntax cannot break.
awk '!/^[a-z_][a-z0-9_]*$/ || /^(fi|done|esac|then|else|do)$/' "$ENTRYPOINT" > "$WORK/functions.sh"
sed -i "s#/opt/openpalm#$WORK/artifacts#g" "$WORK/functions.sh"

# shellcheck disable=SC1091
source "$WORK/functions.sh"

install_runtime_artifacts
`;

type ScenarioResult = { exitCode: number; stderr: string; npmLog: string };

function runInstallScenario(scenarioEnv: Record<string, string>): ScenarioResult {
  const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-p5d-entrypoint-'));
  try {
    const driverPath = join(tempDir, 'driver.sh');
    writeFileSync(driverPath, DRIVER, { mode: 0o755 });
    const npmLogPath = join(tempDir, 'npm.log');
    writeFileSync(npmLogPath, '');
    const home = join(tempDir, 'home');
    mkdirSync(home, { recursive: true });
    const proc = spawnSync('bash', [driverPath, ENTRYPOINT_PATH, tempDir], {
      encoding: 'utf8',
      // Deterministic env: only PATH/HOME plus the scenario's vars. No
      // OP_*_VERSION or PLATFORM_VERSION leaks in from the outer process.
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        NPM_LOG: npmLogPath,
        ...scenarioEnv,
      },
    });
    return {
      exitCode: proc.status ?? 1,
      stderr: proc.stderr ?? '',
      npmLog: readFileSync(npmLogPath, 'utf8'),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractFunction(source: string, name: string): string | null {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'));
  return match ? match[0] : null;
}

// ── Behavioral: exact-pin version resolution for @openpalm/client ───────────

describe('P5d install_runtime_artifacts — @openpalm/client version resolution (behavioral)', () => {
  test('OP_CLIENT_VERSION override wins over PLATFORM_VERSION', () => {
    const result = runInstallScenario({
      OP_CLIENT_VERSION: '9.9.9-test',
      PLATFORM_VERSION: '1.1.1-platform',
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npmLog).toContain('@openpalm/client@9.9.9-test');
    expect(result.npmLog).not.toContain('@openpalm/client@1.1.1-platform');
  });

  test('falls back to PLATFORM_VERSION when OP_CLIENT_VERSION is unset', () => {
    const result = runInstallScenario({
      PLATFORM_VERSION: '1.1.1-platform',
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npmLog).toContain('@openpalm/client@1.1.1-platform');
  });

  test('hard error naming OP_CLIENT_VERSION when neither version source is set (no latest fallback, §8 rule 1)', () => {
    const result = runInstallScenario({});
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('OP_CLIENT_VERSION');
    // Never silently resolve to a moving tag.
    expect(result.npmLog).not.toContain('@latest');
  });

  test('client install failure AFTER version resolution warns and continues (warm-restart resilience, plan §3)', () => {
    const result = runInstallScenario({
      OP_CLIENT_VERSION: '9.9.9-test',
      PLATFORM_VERSION: '1.1.1-platform',
      STUB_NPM_FAIL_PATTERN: '@openpalm/client',
    });
    // A registry blip must not brick a previously-working container.
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/@openpalm\/client@9\.9\.9-test install failed/);
  });

  test('creates current artifact prefixes before npm install so old named volumes can upgrade', () => {
    const result = runInstallScenario({
      OP_CLIENT_VERSION: '9.9.9-test',
      OP_SKELETON_VERSION: '2.2.2-test',
      PLATFORM_VERSION: '1.1.1-platform',
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npmLog).toContain('--prefix');
    expect(result.stderr).not.toContain('missing prefix directory');
  });

  // CHARACTERIZATION (green before AND after P5d): the skeleton pull is
  // untouched by this phase. OP_UI_VERSION is supplied only so the pre-P5d
  // entrypoint gets past its (to-be-removed) UI version gate; after P5d it is
  // simply ignored.
  test('skeleton resolution unchanged: OP_SKELETON_VERSION override still installs that exact pin (characterization)', () => {
    const result = runInstallScenario({
      OP_CLIENT_VERSION: '1.1.1-platform',
      OP_UI_VERSION: '1.1.1-platform',
      OP_SKELETON_VERSION: '2.2.2-test',
      PLATFORM_VERSION: '1.1.1-platform',
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.npmLog).toContain('@openpalm/skeleton@2.2.2-test');
  });
});

// ── STATIC-ONLY checks (no docker daemon in this environment; content
//    assertions + bash -n are the verification limit here) ──────────────────

describe('P5d entrypoint — client co-process (static-only)', () => {
  test('entrypoint installs @openpalm/client, with no @openpalm/ui remnants', () => {
    expect(entrypoint).toContain('@openpalm/client');
    expect(entrypoint).not.toContain('@openpalm/ui');
    // Artifact prefix mirrors the landed layout under the persistent
    // assistant-artifacts volume (/opt/openpalm).
    expect(entrypoint).toContain('/opt/openpalm/client');
    expect(entrypoint).not.toContain('/opt/openpalm/ui');
  });

  test('legacy OP_UI_VERSION resolution is replaced by OP_CLIENT_VERSION', () => {
    expect(entrypoint).toContain('OP_CLIENT_VERSION');
    expect(entrypoint).not.toContain('OP_UI_VERSION');
  });

  test('start_client replaces start_ui in both definition and boot sequence', () => {
    expect(entrypoint).toMatch(/^start_client\(\) \{/m);
    expect(entrypoint).not.toMatch(/^start_ui\(\) \{/m);
    // Boot sequence: bare invocation at column 0.
    expect(entrypoint).toMatch(/^start_client$/m);
    expect(entrypoint).not.toMatch(/^start_ui$/m);
  });

  test('co-process launch exports no OPENCODE_API_URL (old wiring bug path deleted — browser talks to OpenCode directly)', () => {
    // Scoped to the co-process function: the cron preamble legitimately
    // forwards the compose-provided OPENCODE_API_URL to akm cron jobs and is
    // NOT the co-process.
    const coProcess = extractFunction(entrypoint, 'start_client') ?? extractFunction(entrypoint, 'start_ui');
    expect(coProcess, 'expected a start_client() co-process function in entrypoint.sh').toBeTruthy();
    expect(coProcess as string).not.toContain('OPENCODE_API_URL');
    // The static client is not an adapter-node server; no @openpalm/ui build entry.
    expect(coProcess as string).not.toContain('build/index.js');
  });

  test('client is served by the package static server on OP_CLIENT_PORT (default 3000), bound to 0.0.0.0 inside the container', () => {
    const startClient = extractFunction(entrypoint, 'start_client') ?? '';
    expect(startClient, 'expected start_client() to be defined').not.toBe('');
    expect(startClient).toContain('serve.mjs');
    expect(startClient).toContain('OP_CLIENT_PORT:-3000');
    // In-container bind is 0.0.0.0; host exposure is governed by the compose
    // port mapping (loopback default) — see assistant-client-compose.test.ts.
    expect(startClient).toContain('0.0.0.0');
  });

  test('runtime-config.json is written beside the build, pointing the BROWSER at the published OpenCode URL', () => {
    expect(entrypoint).toContain('runtime-config.json');
    // Default: the host-published assistant port (what a browser can reach),
    // NOT the in-container :4096.
    expect(entrypoint).toContain('OP_ASSISTANT_PORT:-3800');
    // Operator override for non-default topologies.
    expect(entrypoint).toContain('OP_CLIENT_DEFAULT_ASSISTANT_URL');
  });

  test('OpenCode is launched with CORS for the shipped browser client origins', () => {
    const startOpencode = extractFunction(entrypoint, 'start_opencode') ?? '';
    expect(startOpencode, 'expected start_opencode() to be defined').not.toBe('');
    expect(startOpencode).toContain('OP_CLIENT_HOST_PORT');
    expect(startOpencode).toContain('OP_HOST_CLIENT_PORT');
    expect(startOpencode).toContain('OP_CLIENT_CORS_ALLOWED_ORIGINS');
    expect(startOpencode).toContain('http://127.0.0.1:${client_host_port}');
    expect(startOpencode).toContain('http://127.0.0.1:${host_client_port}');
    expect(startOpencode).toContain('OP_CLIENT_BIND_ADDRESS');
    expect(startOpencode).toContain('OP_ASSISTANT_BIND_ADDRESS');
    // I3 (review, security-critical): a wildcard CORS grant must NEVER be
    // constructed, even for the wildcard-bind LAN case that used to add one.
    expect(startOpencode).not.toContain('cors_origins+=("*")');
    expect(startOpencode).not.toContain("cors_origins+=('*')");
    expect(startOpencode).toContain('cmd+=(--cors "$origin")');
  });

  // I3 RESIDUAL (review, SECURITY): the array-literal-scoped checks above
  // catch every origin the entrypoint itself constructs, but
  // OP_CLIENT_CORS_ALLOWED_ORIGINS entries are OPERATOR-supplied and were
  // appended to cors_origins with no validation — an operator setting
  // OP_CLIENT_CORS_ALLOWED_ORIGINS=* would reintroduce a wildcard grant on
  // OpenCode through the one knob the fix directs operators toward. Pin that
  // every entry is validated (mirroring guardian's normalizeExactOrigin,
  // packages/guardian/src/config.ts:31) before it ever reaches cors_origins,
  // and that a rejection is logged loudly, naming the value.
  test('start_opencode validates every OP_CLIENT_CORS_ALLOWED_ORIGINS entry and loudly rejects anything invalid (I3 residual, SECURITY)', () => {
    const startOpencode = extractFunction(entrypoint, 'start_opencode') ?? '';
    expect(startOpencode, 'expected start_opencode() to be defined').not.toBe('');
    expect(startOpencode).toContain('is_allowed_cors_origin');
    expect(startOpencode).toMatch(/rejecting/i);
  });

  // H2 (review, CONFIRMED): a wildcard client bind (0.0.0.0/::) derives NO
  // auto-generated LAN CORS origin (see the I3 comment right above the
  // origin-derivation `if` in start_opencode) — by design, since a wildcard
  // bind cannot be turned into the one true browser Origin a LAN visitor's
  // browser will send. But when OPENCODE_AUTH is ALSO enabled (the legitimate
  // hardened-LAN path start_client's own safety gate allows through), that
  // silent gap left LAN chat failing OpenCode's CORS preflight with only a
  // source comment to explain it — no operator-facing signal at all. Pin
  // that a loud runtime warning, naming the fix-it knob
  // (OP_CLIENT_CORS_ALLOWED_ORIGINS), is emitted to stderr specifically in
  // that configuration (static: extractFunction + regex, consistent with the
  // other start_opencode CORS assertions in this describe block — invoking
  // start_opencode behaviorally would exec a real `opencode` process and
  // touch hardcoded absolute host paths (/work, /home/opencode) outside the
  // FUNCTION_DRIVER's sandbox).
  test('start_opencode warns loudly when a wildcard client bind combines with OPENCODE_AUTH enabled and no explicit CORS origins (H2)', () => {
    const startOpencode = extractFunction(entrypoint, 'start_opencode') ?? '';
    expect(startOpencode, 'expected start_opencode() to be defined').not.toBe('');
    // The warning must exist, go to stderr, and name the operator knob.
    expect(startOpencode).toMatch(/WARNING:[^\n]*OP_CLIENT_CORS_ALLOWED_ORIGINS/);
    // Gated on: wildcard client bind ...
    expect(startOpencode).toMatch(/client_bind_address"\s*=\s*"0\.0\.0\.0"/);
    expect(startOpencode).toMatch(/client_bind_address"\s*=\s*"::"/);
    // ... AND auth enabled ...
    expect(startOpencode).toMatch(/opencode_auth_enabled/);
    // ... AND no explicit origins already configured to fill the gap.
    expect(startOpencode).toMatch(/-z\s+"\$\{OP_CLIENT_CORS_ALLOWED_ORIGINS:-\}"/);
  });

  // I3 (review, security-critical, DECIDED POSTURE): "never emit `--cors *`
  // anywhere — explicit origins only" is a repo-wide invariant, not just a
  // property of one branch in start_opencode. Grep the WHOLE entrypoint (not
  // just the extracted function) so a future edit anywhere in the file can
  // never reintroduce a wildcard CORS grant.
  test('the entrypoint never emits a wildcard CORS origin anywhere (I3)', () => {
    // Scoped to CORS-specific constructs (the `--cors` flag itself and the
    // `cors_origins` array it's built from), not a blanket ban on the
    // two-character substring `"*"` anywhere in the file — that would
    // false-fail on any unrelated future edit containing a legitimate `"*"`
    // (a comment, a glob string, an unrelated array literal).
    expect(entrypoint).not.toMatch(/--cors\s+["']?\*/);
    expect(entrypoint).not.toContain('cors_origins+=("*")');
    expect(entrypoint).not.toContain("cors_origins+=('*')");
    expect(entrypoint).not.toMatch(/cors_origins\s*=\s*\(\s*["']?\*["']?\s*\)/);
  });

  // CHARACTERIZATION (green today): syntax gate. shellcheck is unavailable in
  // this environment (documented limitation) — bash -n is the floor.
  test('entrypoint stays bash -n clean (characterization)', () => {
    const proc = spawnSync('bash', ['-n', ENTRYPOINT_PATH], { encoding: 'utf8' });
    expect(proc.status, proc.stderr).toBe(0);
  });

  // I5 (review): the entrypoint's inline JS writer and the lib's
  // client-runtime-config.ts writer must agree on the locked default
  // connection's id/label — otherwise a future shared origin would make one
  // writer's boot silently delete/replace the other's locked entry. Import
  // the EXPORTED constants rather than re-typing the literal so this test
  // cannot drift from the lib source of truth.
  test('entrypoint embeds the SAME locked-connection id/label the lib writer exports (I5)', () => {
    expect(entrypoint).toContain(`id: "${ASSISTANT_LOCKED_CONNECTION_ID}"`);
    expect(entrypoint).toContain(`label: "${ASSISTANT_LOCKED_CONNECTION_LABEL}"`);
    // The old, divergent literal must be fully gone — not just superseded.
    expect(entrypoint).not.toContain('assistant-container-opencode');
  });

  // E1 (review): a browser-facing URL must never carry a wildcard bind host,
  // even when the source is an operator override (OP_CLIENT_DEFAULT_ASSISTANT_URL)
  // that could itself be misderived from a bind-address setting upstream.
  // Mirrors packages/lib/src/control-plane/url-normalize.ts normalizeLoopbackUrl.
  test('start_client normalizes a wildcard host out of the runtime-config URL before writing it (E1, static)', () => {
    const startClient = extractFunction(entrypoint, 'start_client') ?? '';
    expect(startClient, 'expected start_client() to be defined').not.toBe('');
    expect(startClient).toMatch(/0\\\.0\\\.0\\\.0/);
    expect(startClient).toContain('127.0.0.1');
    expect(startClient).toContain('normalizedUrl');
  });
});

describe('P5d assistant Dockerfile (static-only)', () => {
  test('no @openpalm/ui co-process remnants; client artifact dir seeded instead', () => {
    expect(dockerfile).not.toContain('/opt/openpalm/ui');
    expect(dockerfile).not.toContain('OP_UI_VERSION');
    expect(dockerfile).toContain('/opt/openpalm/client');
  });

  // CHARACTERIZATION (green today): PLATFORM_VERSION is already wired
  // (build ARG re-exported as ENV) — the entrypoint fallback depends on it.
  test('PLATFORM_VERSION build arg is re-exported for runtime resolution (characterization)', () => {
    expect(dockerfile).toContain('ARG PLATFORM_VERSION');
    expect(dockerfile).toMatch(/PLATFORM_VERSION=\$\{PLATFORM_VERSION\}/);
  });

  // I2 (review): boot-time `npm install @openpalm/client` has no fallback —
  // an offline/air-gapped/npm-outage first boot silently ships no chat
  // surface on OP_CLIENT_PORT. Bake a real client build into the image at
  // build time (mirrors containers/guardian/Dockerfile's baked
  // guardian/skeleton install) so the assistant-artifacts named volume seeds
  // itself from real content the first time it is created.
  test('bakes a fallback @openpalm/client install at build time (I2)', () => {
    expect(dockerfile).toMatch(/npm install --prefix \/opt\/openpalm\/client "@openpalm\/client@\$\{PLATFORM_VERSION\}"/);
  });
});

describe('I2 — entrypoint client co-process supervision (static-only)', () => {
  test('start_client respawns the co-process with a capped, backed-off retry loop', () => {
    const startClient = extractFunction(entrypoint, 'start_client') ?? '';
    expect(startClient, 'expected start_client() to be defined').not.toBe('');
    // A retry loop must exist around the node invocation...
    expect(startClient).toMatch(/while true; do/);
    // ...that is CAPPED (gives up eventually, does not retry forever)...
    expect(startClient).toMatch(/max_attempts/);
    // ...and BACKED OFF (the delay grows and is capped), mirroring
    // packages/cli/src/lib/client-server.ts's respawn semantics.
    expect(startClient).toMatch(/delay \* 2/);
    expect(startClient).toMatch(/max_delay/);
  });
});

// ── Behavioral harness for start_client / start_opencode (I2/I3/E1/I5) ──────
// A second driver, distinct from the install_runtime_artifacts one above: it
// seeds a FAKE already-installed @openpalm/client package (serve.mjs + a
// built index.html) so start_client gets past its "build not found" gate,
// then invokes whichever function the scenario needs. `node` and `sleep` are
// stubbed so the capped-backoff loop (which really sleeps 1/2/4/8/16s)
// resolves near-instantly in tests.
const FUNCTION_DRIVER = `#!/usr/bin/env bash
set -uo pipefail

ENTRYPOINT="$1"
WORK="$2"
FUNC="$3"
export WORK

mkdir -p "$WORK/bin"

# Resolve the REAL node BEFORE shadowing PATH with the stub dir below, so the
# stub can delegate genuine \`-e\` evals (the runtime-config.json writer) to a
# real interpreter — E1/I5 assert on the ACTUAL JSON the entrypoint's inline
# JS produces — while only intercepting/controlling the serve.mjs
# invocation (the thing under test for I2's supervision loop).
export REAL_NODE="$(command -v node)"

cat > "$WORK/bin/node" <<'STUB'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >> "$NPM_LOG"
if printf '%s' "$*" | grep -q "serve.mjs"; then
  # SUPERVISOR-RESET test hook: if STUB_NODE_HEALTHY_AT is set, count
  # serve.mjs invocations (persisted in a file under $WORK so it survives
  # across the loop's repeated node stub invocations) and really sleep past
  # the (test-shrunk) healthy-uptime threshold on the Nth invocation, so the
  # supervision loop's own elapsed-time measurement sees a genuinely long
  # run. Every other invocation returns instantly, same as before this hook
  # existed.
  if [ -n "\${STUB_NODE_HEALTHY_AT:-}" ]; then
    count_file="$WORK/node-invocations.count"
    count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
    echo "$count" > "$count_file"
    if [ "$count" = "\${STUB_NODE_HEALTHY_AT}" ]; then
      /bin/sleep "\${STUB_NODE_HEALTHY_SLEEP_S:-1.5}"
    fi
  fi
  # "keeps running" test hook: a real client does not exit right after
  # starting — it serves traffic indefinitely. Scenarios that only care
  # about the SYNCHRONOUS part of start_client (config written, the I3
  # safety gate's decision, the first serve.mjs invocation) opt into this via
  # STUB_NODE_ALWAYS_SLEEP_S so the respawn loop never reaches a give-up
  # state during the bounded observation window below — without it, the
  # default instant-exit stub makes EVERY start_client scenario cycle
  # through all give-up attempts in a few milliseconds, which is honest for
  # the crash-loop tests (I2/F4/SUPERVISOR-RESET) but wrong for a
  # "starts fine" scenario.
  if [ -n "\${STUB_NODE_ALWAYS_SLEEP_S:-}" ]; then
    /bin/sleep "\${STUB_NODE_ALWAYS_SLEEP_S}"
  fi
  exit "\${STUB_NODE_SERVE_EXIT:-0}"
fi
exec "$REAL_NODE" "$@"
STUB
chmod +x "$WORK/bin/node"

# Instant no-op sleep so the capped-backoff loop doesn't really wait.
cat > "$WORK/bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$WORK/bin/sleep"

export PATH="$WORK/bin:$PATH"

# Fake an already-installed @openpalm/client package + build so start_client
# gets past its "build not found" gate in every scenario — UNLESS
# STUB_SKIP_CLIENT_BUILD is set (F4: simulates a missing/never-installed
# client build so the "build not found" skip path itself can be exercised).
CLIENT_PKG="$WORK/artifacts/client/node_modules/@openpalm/client"
mkdir -p "$CLIENT_PKG/bin" "$CLIENT_PKG/build"
if [ -z "\${STUB_SKIP_CLIENT_BUILD:-}" ]; then
  : > "$CLIENT_PKG/bin/serve.mjs"
  : > "$CLIENT_PKG/build/index.html"
fi

awk '!/^[a-z_][a-z0-9_]*$/ || /^(fi|done|esac|then|else|do)$/' "$ENTRYPOINT" > "$WORK/functions.sh"
sed -i "s#/opt/openpalm#$WORK/artifacts#g" "$WORK/functions.sh"
sed -i "s#/tmp/openpalm-client-skip#$WORK/client-skip-marker#g" "$WORK/functions.sh"

# shellcheck disable=SC1091
source "$WORK/functions.sh"

"$FUNC"

# start_client backgrounds its supervision loop and returns immediately (the
# real entrypoint then execs OpenCode and keeps running under tini) — but
# spawnSync does NOT wait for an orphaned grandchild holding the stdio pipes
# open once THIS driver process exits, so waiting here is required for the
# test to observe the loop's output at all.
#
# BOUNDED wait, not a blind 'wait': every crash/backoff/reset scenario in
# this suite (I2 give-up, F4, SUPERVISOR-RESET) finishes on its own — via
# instant stub exits, or SUPERVISOR-RESET's one genuinely-slept ~1.5s
# interval — comfortably inside this cap. A "keeps running" scenario
# (STUB_NODE_ALWAYS_SLEEP_S) is DELIBERATELY longer than the cap so it never
# finishes naturally here; once the cap is hit, any still-running
# supervision loop is reaped so its held-open stdio can't hang spawnSync.
for _ in $(seq 1 30); do
  [ -z "$(jobs -r)" ] && break
  /bin/sleep 0.1
done
kill $(jobs -p) 2>/dev/null || true
wait 2>/dev/null || true
`;

type FunctionScenarioResult = {
  exitCode: number;
  stderr: string;
  npmLog: string;
  skipMarkerExists: boolean;
  runtimeConfig: string | null;
};

function runFunctionScenario(
  func: string,
  scenarioEnv: Record<string, string>,
): FunctionScenarioResult {
  const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-p5d-fn-'));
  try {
    const driverPath = join(tempDir, 'driver.sh');
    writeFileSync(driverPath, FUNCTION_DRIVER, { mode: 0o755 });
    const npmLogPath = join(tempDir, 'npm.log');
    writeFileSync(npmLogPath, '');
    const home = join(tempDir, 'home');
    mkdirSync(home, { recursive: true });
    const proc = spawnSync('bash', [driverPath, ENTRYPOINT_PATH, tempDir, func], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        NPM_LOG: npmLogPath,
        ...scenarioEnv,
      },
    });
    const runtimeConfigPath = join(
      tempDir,
      'artifacts/client/node_modules/@openpalm/client/runtime-config.json',
    );
    let runtimeConfig: string | null = null;
    try {
      runtimeConfig = readFileSync(runtimeConfigPath, 'utf8');
    } catch {
      runtimeConfig = null;
    }
    return {
      exitCode: proc.status ?? 1,
      stderr: proc.stderr ?? '',
      npmLog: readFileSync(npmLogPath, 'utf8'),
      skipMarkerExists: (() => {
        try {
          readFileSync(join(tempDir, 'client-skip-marker'));
          return true;
        } catch {
          return false;
        }
      })(),
      runtimeConfig,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── I3 residual (SECURITY): is_allowed_cors_origin behavioral harness ───────
// A minimal driver, distinct from FUNCTION_DRIVER above: it sources ONLY the
// entrypoint's function definitions (same awk strip) and calls
// is_allowed_cors_origin directly with one candidate origin — no docker/
// opencode boot, no /work or /home/opencode side effects (start_opencode
// itself is not invoked).
function checkCorsOrigin(origin: string): { exitCode: number; stderr: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-cors-origin-'));
  try {
    const functionsPath = join(tempDir, 'functions.sh');
    const driverPath = join(tempDir, 'driver.sh');
    writeFileSync(driverPath, [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'awk \'!/^[a-z_][a-z0-9_]*$/ || /^(fi|done|esac|then|else|do)$/\' "$1" > "$2"',
      '# shellcheck disable=SC1090',
      'source "$2"',
      'is_allowed_cors_origin "$3"',
      '',
    ].join('\n'), { mode: 0o755 });
    const proc = spawnSync('bash', [driverPath, ENTRYPOINT_PATH, functionsPath, origin], { encoding: 'utf8' });
    return { exitCode: proc.status ?? 1, stderr: proc.stderr ?? '' };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('I3 residual — is_allowed_cors_origin (behavioral): mirrors guardian normalizeExactOrigin', () => {
  test('rejects a bare wildcard', () => {
    expect(checkCorsOrigin('*').exitCode).not.toBe(0);
  });

  test('accepts an exact http origin (with port)', () => {
    expect(checkCorsOrigin('http://example.com:1234').exitCode).toBe(0);
  });

  test('accepts an exact https origin', () => {
    expect(checkCorsOrigin('https://example.com').exitCode).toBe(0);
  });

  test('accepts an origin with a bare trailing slash (still an exact origin)', () => {
    expect(checkCorsOrigin('http://example.com/').exitCode).toBe(0);
  });

  test('rejects a non-http(s) scheme', () => {
    expect(checkCorsOrigin('ftp://example.com').exitCode).not.toBe(0);
  });

  test('rejects an origin with a path', () => {
    expect(checkCorsOrigin('http://example.com/path').exitCode).not.toBe(0);
  });

  test('rejects an origin with userinfo', () => {
    expect(checkCorsOrigin('http://user@example.com').exitCode).not.toBe(0);
  });

  test('rejects an origin with a query string', () => {
    expect(checkCorsOrigin('http://example.com?x=1').exitCode).not.toBe(0);
  });

  test('rejects an origin with a fragment', () => {
    expect(checkCorsOrigin('http://example.com#frag').exitCode).not.toBe(0);
  });

  test('rejects garbage input', () => {
    expect(checkCorsOrigin('not a url').exitCode).not.toBe(0);
  });
});

describe('I3 — start_client LAN-exposure safety gate (behavioral)', () => {
  test('refuses to start the client co-process when the assistant binds non-loopback AND OpenCode auth is disabled', () => {
    const result = runFunctionScenario('start_client', {
      OP_ASSISTANT_BIND_ADDRESS: '0.0.0.0',
      // OPENCODE_AUTH left unset — defaults to "false" (disabled), matching
      // the shipped compose default (core.compose.yml OPENCODE_AUTH: "false").
    });
    expect(result.stderr).toContain('OPENCODE_AUTH');
    expect(result.stderr).toContain('OP_ASSISTANT_BIND_ADDRESS');
    expect(result.skipMarkerExists, 'expected the client-skip marker to be written').toBe(true);
    // The unsafe path must never reach the node serve invocation.
    expect(result.npmLog).not.toContain('serve.mjs');
    expect(result.runtimeConfig, 'runtime-config.json must not be written on the unsafe path').toBeNull();
  });

  test('starts the client normally when the assistant bind stays loopback (today\'s default deployment)', () => {
    // STUB_NODE_ALWAYS_SLEEP_S: simulate a client that starts fine and keeps
    // serving (like the real co-process) rather than exiting instantly —
    // without this, the default instant-exit stub makes the respawn loop
    // cycle through all give-up attempts within the bounded observation
    // window regardless of scenario, which would make F4's now-correct
    // give-up marker write look like it fired on a "normal" start too.
    const result = runFunctionScenario('start_client', { STUB_NODE_ALWAYS_SLEEP_S: '6' });
    expect(result.skipMarkerExists).toBe(false);
    expect(result.npmLog).toContain('serve.mjs');
    expect(result.runtimeConfig).not.toBeNull();
  });

  test('starts the client when bound non-loopback but OPENCODE_AUTH is explicitly enabled (legitimate hardened LAN path)', () => {
    const result = runFunctionScenario('start_client', {
      OP_ASSISTANT_BIND_ADDRESS: '0.0.0.0',
      OPENCODE_AUTH: 'true',
      STUB_NODE_ALWAYS_SLEEP_S: '6',
    });
    expect(result.skipMarkerExists).toBe(false);
    expect(result.npmLog).toContain('serve.mjs');
  });
});

describe('E1 — start_client runtime-config URL normalization (behavioral)', () => {
  test('a wildcard-host OP_CLIENT_DEFAULT_ASSISTANT_URL override is normalized to loopback before it reaches runtime-config.json', () => {
    const result = runFunctionScenario('start_client', {
      OP_CLIENT_DEFAULT_ASSISTANT_URL: 'http://0.0.0.0:3800',
    });
    expect(result.runtimeConfig, 'expected runtime-config.json to be written').not.toBeNull();
    const config = JSON.parse(result.runtimeConfig as string);
    expect(config.connections[0].url).toBe('http://127.0.0.1:3800');
  });
});

describe('I5 — start_client runtime-config connection id/label (behavioral)', () => {
  test('the written locked connection uses the lib-exported id/label', () => {
    const result = runFunctionScenario('start_client', {});
    expect(result.runtimeConfig).not.toBeNull();
    const config = JSON.parse(result.runtimeConfig as string);
    expect(config.connections[0].id).toBe(ASSISTANT_LOCKED_CONNECTION_ID);
    expect(config.connections[0].label).toBe(ASSISTANT_LOCKED_CONNECTION_LABEL);
  });
});

describe('I2 — start_client co-process supervision (behavioral)', () => {
  test('respawns on unexpected exit and gives up after the attempt cap, logging the give-up message', () => {
    const result = runFunctionScenario('start_client', {
      STUB_NODE_SERVE_EXIT: '1',
    });
    // Every attempt is logged; the loop must stop (not run forever) and say so.
    const respawnCount = (result.stderr.match(/restarting in/g) ?? []).length;
    expect(respawnCount).toBeGreaterThan(0);
    expect(result.stderr).toMatch(/giving up on respawn/);
  });

  // F4 (review, CONFIRMED): giving up on respawn is a non-fatal, permanent
  // condition for the rest of this boot — the healthcheck (Dockerfile +
  // core.compose.yml) probes OP_CLIENT_PORT UNLESS /tmp/openpalm-client-skip
  // exists. Before the fix, the give-up path exited without writing that
  // marker, so a persistently-crashing client made the healthcheck fail
  // forever -> assistant unhealthy -> guardian's `depends_on: condition:
  // service_healthy` blocks every service behind it, directly contradicting
  // the give-up log line's own claim that "the assistant keeps serving
  // without it".
  test('F4: writes the client-skip marker after giving up on respawn (so the healthcheck stops expecting a dead client)', () => {
    const result = runFunctionScenario('start_client', {
      STUB_NODE_SERVE_EXIT: '1',
    });
    expect(result.stderr).toMatch(/giving up on respawn/);
    expect(result.skipMarkerExists, 'expected /tmp/openpalm-client-skip to be written after giving up').toBe(true);
  });
});

// ── F4 (review, CONFIRMED): "client build not found" must also skip healthy ──
describe('F4 — start_client "build not found" skip path writes the client-skip marker', () => {
  test('writes /tmp/openpalm-client-skip when the client build is missing, so the healthcheck does not expect a client that was never installed', () => {
    const result = runFunctionScenario('start_client', {
      STUB_SKIP_CLIENT_BUILD: '1',
    });
    expect(result.stderr).toContain('client co-process skipped');
    expect(result.skipMarkerExists, 'expected /tmp/openpalm-client-skip to be written on the build-not-found path').toBe(true);
    // The build-not-found path returns before ever invoking serve.mjs.
    expect(result.npmLog).not.toContain('serve.mjs');
  });
});

// ── SUPERVISOR-RESET (review, CONFIRMED): the respawn attempt counter must ──
// reset after a sustained healthy run, mirroring
// packages/cli/src/lib/client-server.ts's HEALTHY_UPTIME_MS reset. Otherwise
// crashes spread arbitrarily far apart across the container's whole lifetime
// (not a tight crash loop) permanently exhaust max_attempts and disable the
// client forever after only 5 crashes, ever.
//
// The node stub's STUB_NODE_HEALTHY_AT hook makes ONE specific invocation
// really sleep (via /bin/sleep, bypassing the instant `sleep` PATH stub) past
// a test-shrunk OP_CLIENT_RESPAWN_HEALTHY_UPTIME_MS threshold, so the
// supervision loop's own real elapsed-time measurement sees a genuinely long
// run and must reset its counter — this is a true behavioral test of the
// timing logic, not a mocked clock.
describe('SUPERVISOR-RESET — start_client respawn counter resets after a sustained healthy run (behavioral)', () => {
  test('a run that stays up past the healthy-uptime threshold resets the give-up counter, so it takes MORE than max_attempts total crashes to give up', () => {
    const result = runFunctionScenario('start_client', {
      STUB_NODE_SERVE_EXIT: '1',
      // Every invocation "crashes" immediately except the 3rd, which sleeps
      // ~1.5s (STUB_NODE_HEALTHY_SLEEP_S default) — comfortably past this
      // 300ms threshold, while every fast (non-healthy) invocation stays
      // comfortably under it (plain process fork/exec overhead).
      OP_CLIENT_RESPAWN_HEALTHY_UPTIME_MS: '300',
      STUB_NODE_HEALTHY_AT: '3',
    });
    // max_attempts is 5: WITHOUT the reset, attempt counts 1,2,3,4,5 across
    // invocations 1-5 and gives up at invocation 5 (4 "restarting" messages
    // logged before it). WITH the reset, invocation 3's long run resets the
    // counter back to 0 before it increments to 1, so giving up is deferred
    // until invocation 7 (6 "restarting" messages logged before it).
    const restartCount = (result.stderr.match(/restarting in/g) ?? []).length;
    expect(result.stderr, result.stderr).toMatch(/giving up on respawn/);
    expect(
      restartCount,
      `expected the healthy run at invocation 3 to reset the counter (>5 restarts before giving up); got stderr:\n${result.stderr}`,
    ).toBeGreaterThan(5);
    expect(result.skipMarkerExists).toBe(true);
  });
});
