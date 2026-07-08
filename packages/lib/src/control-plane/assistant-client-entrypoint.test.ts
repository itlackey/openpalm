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
    expect(startOpencode).toContain('cors_origins+=("*")');
    expect(startOpencode).toContain('cmd+=(--cors "$origin")');
  });

  // CHARACTERIZATION (green today): syntax gate. shellcheck is unavailable in
  // this environment (documented limitation) — bash -n is the floor.
  test('entrypoint stays bash -n clean (characterization)', () => {
    const proc = spawnSync('bash', ['-n', ENTRYPOINT_PATH], { encoding: 'utf8' });
    expect(proc.status, proc.stderr).toBe(0);
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
});
