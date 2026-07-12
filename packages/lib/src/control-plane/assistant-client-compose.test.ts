/**
 * P5d (#510 Slice A) — compose publishes the client co-process port.
 *
 * RED tests written BEFORE the implementation (plan §6.9 known gap 1: "the
 * co-process port is not published in any compose file"; Phase 5 item 4:
 * "Publish the port in compose behind the existing bind-address policy").
 *
 * All checks here are STATIC-ONLY: the managed compose YAML is parsed
 * directly (same pattern as network-partitioning.test.ts) — no docker daemon
 * exists in the dev/CI container, so `docker compose config` cannot be run.
 *
 * Tests marked CHARACTERIZATION pass against the current tree and pin landed
 * behavior the P5d implementation must not regress.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const STACK_DIR = join(REPO_ROOT, 'packages/skeleton/system/stack');

type ComposeService = {
  ports?: unknown[];
  environment?: Record<string, unknown> | string[];
  volumes?: unknown[];
  healthcheck?: { test?: unknown };
};
type ComposeDoc = { services?: Record<string, ComposeService> };

const core = yamlParse(readFileSync(join(STACK_DIR, 'core.compose.yml'), 'utf8')) as ComposeDoc;
const assistant = core.services?.assistant;
const assistantPorts: string[] = (assistant?.ports ?? []).map(String);
const clientPortEntries = assistantPorts.filter((p) => p.includes('OP_CLIENT_PORT'));

/** True when the service environment (map or list form) defines `name`. */
function environmentHas(service: ComposeService | undefined, name: string): boolean {
  const env = service?.environment;
  if (!env) return false;
  if (Array.isArray(env)) return env.some((e) => String(e).startsWith(`${name}=`));
  return Object.keys(env).includes(name);
}

describe('P5d compose — client port published on the assistant service', () => {
  test('a client port mapping (OP_CLIENT_PORT) exists on the assistant service', () => {
    expect(assistant, 'assistant service must exist in core.compose.yml').toBeTruthy();
    expect(
      clientPortEntries.length,
      `expected an OP_CLIENT_PORT mapping among assistant ports: ${JSON.stringify(assistantPorts)}`,
    ).toBeGreaterThan(0);
  });

  test('client port host bind respects the OP_BIND_ADDRESS policy with a loopback default', () => {
    // Accepts the global form `${OP_BIND_ADDRESS:-127.0.0.1}` or the nested
    // per-service override form
    // `${OP_CLIENT_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}` (C1 pattern).
    // Either way the default MUST be loopback and the global policy honored.
    for (const entry of clientPortEntries) {
      expect(entry).toContain('OP_BIND_ADDRESS:-127.0.0.1');
    }
    expect(clientPortEntries.length).toBeGreaterThan(0);
  });

  test('client port maps to the in-container serve port (entrypoint default 3000)', () => {
    // Container side must be the port start_client serves on: a literal 3000
    // or the OP_CLIENT_PORT variable defaulting to 3000.
    const matching = clientPortEntries.filter((entry) =>
      /:(\$\{OP_CLIENT_PORT(:-3000)?\}|3000)$/.test(entry),
    );
    expect(
      matching.length,
      `no client port entry targets container port 3000: ${JSON.stringify(clientPortEntries)}`,
    ).toBeGreaterThan(0);
  });
});

describe('P5d compose — stack env plumbing for the exact-pin client artifact', () => {
  test('OP_CLIENT_VERSION passes through to the assistant container (docker restart with a new pin picks up the new client)', () => {
    // Plan §11 acceptance: `docker restart` with a new OP_CLIENT_VERSION must
    // pick up the new artifact — so the env var has to reach the entrypoint
    // through the assistant service environment, not just compose
    // interpolation.
    expect(environmentHas(assistant, 'OP_CLIENT_VERSION')).toBe(true);
  });

  test('OP_SKELETON_VERSION also passes through to the assistant container', () => {
    // The assistant entrypoint installs both @openpalm/client and
    // @openpalm/skeleton. A stack env override must reach the runtime
    // environment or the container hard-fails before OpenCode starts.
    expect(environmentHas(assistant, 'OP_SKELETON_VERSION')).toBe(true);
  });

  test('assistant receives host client ports for OpenCode CORS origin defaults', () => {
    expect(environmentHas(assistant, 'OP_CLIENT_HOST_PORT')).toBe(true);
    expect(environmentHas(assistant, 'OP_HOST_CLIENT_PORT')).toBe(true);
    expect(environmentHas(assistant, 'OP_CLIENT_CORS_ALLOWED_ORIGINS')).toBe(true);
    expect(environmentHas(assistant, 'OP_BIND_ADDRESS')).toBe(true);
    expect(environmentHas(assistant, 'OP_ASSISTANT_BIND_ADDRESS')).toBe(true);
    expect(environmentHas(assistant, 'OP_CLIENT_BIND_ADDRESS')).toBe(true);
  });

  // CHARACTERIZATION (green today): the client artifact installs under
  // /opt/openpalm, which is the persistent assistant-artifacts named volume —
  // warm restarts must keep reusing the installed client.
  test('assistant-artifacts volume still persists /opt/openpalm (characterization)', () => {
    const volumes = (assistant?.volumes ?? []).map(String);
    expect(volumes).toContain('assistant-artifacts:/opt/openpalm');
  });
});

describe('P5d docs — new env vars are documented (static-only)', () => {
  test('OP_CLIENT_VERSION and OP_CLIENT_PORT appear in the stack env docs', () => {
    const envAndMounts = readFileSync(
      join(REPO_ROOT, 'docs/technical/environment-and-mounts.md'),
      'utf8',
    );
    const consolidated = readFileSync(
      join(REPO_ROOT, 'docs/technical/consolidated-stack-env.md'),
      'utf8',
    );
    const combined = envAndMounts + consolidated;
    // Boolean asserts keep the failure output readable (no full-doc dump).
    expect(
      combined.includes('OP_CLIENT_VERSION'),
      'neither environment-and-mounts.md nor consolidated-stack-env.md documents OP_CLIENT_VERSION',
    ).toBe(true);
    expect(
      combined.includes('OP_CLIENT_PORT'),
      'neither environment-and-mounts.md nor consolidated-stack-env.md documents OP_CLIENT_PORT',
    ).toBe(true);
  });
});

// ── I2 (review): compose healthcheck coverage for the client co-process ─────
// A boot-time `npm install @openpalm/client` failure previously left
// OP_CLIENT_PORT published with nothing listening while the healthcheck only
// probed OpenCode (:4096) — the stack reported healthy regardless. The
// healthcheck must also probe the client, skippable only via the
// entrypoint's deliberate I3 safety-skip marker (not a generic escape hatch).
describe('I2 — assistant healthcheck also probes the client co-process', () => {
  const healthcheckTest = String(assistant?.healthcheck?.test ?? []);

  test('the healthcheck command probes the client port, not just OpenCode', () => {
    expect(healthcheckTest).toContain('4096');
    // Must resolve, one way or another, to the client's port in-container.
    expect(healthcheckTest).toMatch(/localhost:(\$\$\{OP_CLIENT_PORT:-3000\}|3000)\//);
  });

  // Reviewer finding (adversarial review, I2 regression): the probe MUST
  // target the FIXED in-container port the client co-process always listens
  // on (3000), never the host-facing OP_CLIENT_PORT knob interpolated by
  // Compose at config-load time. OP_CLIENT_PORT is the operator-facing HOST
  // port mapping value (default 3810, commonly overridden — see
  // docs/operations/manual-compose-runbook.md); it is deliberately NEVER
  // passed into the container's own environment (see the volumes/ports
  // comments above), so the client co-process always serves on the fixed
  // in-container port 3000 regardless of OP_CLIENT_PORT.
  //
  // A raw (unescaped) `${OP_CLIENT_PORT:-3000}` fragment in a CMD-SHELL
  // healthcheck gets interpolated by Compose using the HOST env BEFORE the
  // container ever sees the string. For an operator who customizes
  // OP_CLIENT_PORT (e.g. OP_CLIENT_PORT=3840), Compose would bake
  // `localhost:3840` into the in-container curl probe — a dead port, since
  // the client is listening on 3000 inside the container. The assistant
  // would then be perpetually "unhealthy", and because guardian has
  // `depends_on: assistant: condition: service_healthy`, a customized
  // OP_CLIENT_PORT deploy would fail the ENTIRE stack.
  //
  // The fix must hardcode `3000`, or escape the reference as
  // `$${OP_CLIENT_PORT:-3000}` so Compose leaves it untouched and the
  // CONTAINER's own shell expands it instead (where OP_CLIENT_PORT is
  // deliberately unset, so it also defaults to 3000) — mirroring how the
  // Dockerfile's own HEALTHCHECK already gets this right via container-side
  // shell expansion (containers/assistant/Dockerfile).
  test('the client probe targets the fixed in-container port, never a host-interpolated OP_CLIENT_PORT (I2 review fix)', () => {
    // A bare (non-doubled) `${OP_CLIENT_PORT...}` reference would be
    // host-interpolated by Compose at config-load time — forbidden.
    const hostInterpolatedReference = /(^|[^$])\$\{OP_CLIENT_PORT\b/;
    expect(
      healthcheckTest,
      `healthcheck must not contain a raw, host-interpolated \${OP_CLIENT_PORT...} reference (bakes the HOST port into the container-side probe): ${healthcheckTest}`,
    ).not.toMatch(hostInterpolatedReference);
  });

  test('the healthcheck exempts the I3 deliberate client-skip marker rather than treating every skip as unhealthy', () => {
    expect(healthcheckTest).toContain('openpalm-client-skip');
  });
});

// ── P1-1 (PR #564 c11): the /health probe must authenticate when the
// container-side OPENCODE_AUTH is truthy — otherwise OpenCode 401s the
// unauthenticated probe under the home-password preset, the healthcheck
// reports unhealthy, and guardian's `depends_on: assistant: condition:
// service_healthy` blocks the entire stack. The gate mirrors the
// entrypoint's opencode_auth_enabled truthy set exactly (D2) so probe and
// server can never disagree about the posture.
describe('P1-1 (#564 c11) — assistant healthcheck authenticates when OPENCODE_AUTH is truthy', () => {
  const healthcheckTest = String(assistant?.healthcheck?.test ?? []);

  // RED today: the probe has no case/-u/username reference at all — it
  // unconditionally curls /health with no credentials.
  test('the OpenCode probe gates on container-side OPENCODE_AUTH and sends Basic credentials when truthy', () => {
    expect(healthcheckTest).toContain('case "$${OPENCODE_AUTH:-false}"');
    expect(healthcheckTest).toContain('true|TRUE|True|1|yes|YES'); // exact entrypoint truthy set
    expect(healthcheckTest).toContain('curl -sf -u "$${OPENCODE_SERVER_USERNAME:-opencode}:');
  });

  // RED today on the positive assertions: the credential fragment does not
  // exist yet. The negative assertions guard the compose-interpolation
  // hazard: a Docker healthcheck process only ever sees the container's
  // CREATED env (compose `environment:` map) — never variables the
  // entrypoint exports later — so the probe must `cat` the secret file
  // itself, container-side (`$$(cat ...)`, doubled for the Compose escape),
  // never a host-interpolated `${...}` fragment (which Compose would
  // resolve against the HOST's env at config-load time, not the container's).
  test('the authenticated probe reads the secret file container-side — no host-interpolated auth fragment', () => {
    expect(healthcheckTest).toContain('$$(cat');
    expect(healthcheckTest).toContain('opencode_server_password');
    for (const name of ['OPENCODE_AUTH', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD_FILE']) {
      const hostInterpolatedReference = new RegExp(`(^|[^$])\\$\\{${name}\\b`);
      expect(
        healthcheckTest,
        `healthcheck must not contain a raw, host-interpolated \${${name}...} reference: ${healthcheckTest}`,
      ).not.toMatch(hostInterpolatedReference);
    }
    // A single-`$` `$(cat` would be host-shell-evaluated at config-load time
    // (and is an invalid Compose interpolation to boot) — only the doubled
    // `$$(cat` (container-side) form is allowed.
    expect(healthcheckTest).not.toMatch(/(^|[^$])\$\(cat/);
  });

  // PIN, green-on-arrival (PR #564 P1-1): the default (auth-off) posture's
  // probe stays byte-stable as the `*)` branch of the new case statement —
  // guards against a "helpful" rewrite that also changes the unauthenticated
  // path's behavior.
  test('the auth-off branch still probes /health plain (default posture unchanged)', () => {
    expect(healthcheckTest).toContain('curl -sf http://localhost:4096/health');
  });

  // RED today (scenario A): the static greps above cannot catch
  // quoting/folding mistakes in the actual interpolated shell command, so
  // this test EXECUTES the probe for real — simulating Compose's `$$` -> `$`
  // interpolation, then running the resulting command under `sh -c` with a
  // stub `curl` that records its argv. No `-u` is ever logged today because
  // the probe has no auth branch at all.
  describe('behavioral: the interpolated probe sends Basic credentials exactly when OPENCODE_AUTH is truthy', () => {
    const probe = String((assistant?.healthcheck?.test as unknown[] | undefined)?.[1] ?? '');

    function runProbeScenario(scenarioEnv: Record<string, string>): { exitCode: number; curlLines: string[] } {
      const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-healthcheck-probe-'));
      try {
        const binDir = join(tempDir, 'bin');
        mkdirSync(binDir, { recursive: true });
        const curlLog = join(tempDir, 'curl.log');
        writeFileSync(curlLog, '');
        writeFileSync(
          join(binDir, 'curl'),
          '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$CURL_LOG"\nexit 0\n',
          { mode: 0o755 },
        );
        // Simulate Compose's `$$` -> `$` interpolation (the probe string
        // contains only `$$` escapes per test 7's negative assertions), then
        // hermeticize the skip-marker path so this run cannot observe or
        // depend on a REAL /tmp file.
        const interpolated = probe
          .replaceAll('$$', '$')
          .replaceAll('/tmp/openpalm-client-skip', join(tempDir, 'client-skip'));
        const proc = spawnSync('sh', ['-c', interpolated], {
          encoding: 'utf8',
          env: {
            PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
            CURL_LOG: curlLog,
            ...scenarioEnv,
          },
        });
        const curlLines = readFileSync(curlLog, 'utf8').split('\n').filter((l) => l.length > 0);
        return { exitCode: proc.status ?? 1, curlLines };
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

    test('scenario A: OPENCODE_AUTH=true sends Basic credentials read from the secret file (default username)', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-healthcheck-secret-'));
      try {
        const secretFile = join(tempDir, 'opencode_server_password');
        writeFileSync(secretFile, 'hc-pass\n');
        const result = runProbeScenario({
          OPENCODE_AUTH: 'true',
          OPENCODE_SERVER_PASSWORD_FILE: secretFile,
        });
        expect(result.exitCode, JSON.stringify(result.curlLines)).toBe(0);
        expect(result.curlLines.length).toBeGreaterThan(0);
        const healthLine = result.curlLines.find((l) => l.includes('/health')) ?? '';
        expect(healthLine).toContain('-u opencode:hc-pass');
        expect(healthLine).toContain('/health');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('scenario B: default posture (OPENCODE_AUTH unset) probes /health with no credentials', () => {
      const result = runProbeScenario({});
      expect(result.exitCode, JSON.stringify(result.curlLines)).toBe(0);
      const healthLine = result.curlLines.find((l) => l.includes('/health')) ?? '';
      expect(healthLine).not.toContain('-u');
    });
  });
});

// ── I4 (review): guardian CORS defaults mirror the assistant's own defaults ─
const portals = yamlParse(
  readFileSync(join(STACK_DIR, 'portals.compose.yml'), 'utf8'),
) as ComposeDoc;
const guardian = portals.services?.guardian;

describe('I4 — guardian CORS default mirrors the shipped client origins', () => {
  test('GUARDIAN_CORS_ALLOWED_ORIGINS defaults to the assistant/host client origins instead of empty', () => {
    expect(guardian, 'guardian service must exist in portals.compose.yml').toBeTruthy();
    const value = String(
      (guardian?.environment as Record<string, unknown> | undefined)?.GUARDIAN_CORS_ALLOWED_ORIGINS ?? '',
    );
    // Must reference BOTH the assistant-container client port and the
    // host-local client app port — the same two ports start_opencode already
    // auto-seeds into OpenCode's CORS allowlist.
    expect(value).toContain('OP_CLIENT_PORT');
    expect(value).toContain('OP_HOST_CLIENT_PORT');
    // Still an operator override, not a hardcoded replacement.
    expect(value).toMatch(/^\$\{GUARDIAN_CORS_ALLOWED_ORIGINS:-/);
    // I3 posture applies here too: never a wildcard default.
    expect(value).not.toContain('*');
  });

  test('GUARDIAN_DIRECT_INGRESS and GUARDIAN_CORS_ALLOWED_ORIGINS are documented together in environment-and-mounts.md', () => {
    const envAndMounts = readFileSync(
      join(REPO_ROOT, 'docs/technical/environment-and-mounts.md'),
      'utf8',
    );
    expect(envAndMounts.includes('GUARDIAN_DIRECT_INGRESS')).toBe(true);
    expect(envAndMounts.includes('GUARDIAN_CORS_ALLOWED_ORIGINS')).toBe(true);
  });

  // #557 D2 — green-on-arrival pin: the hosted origin is deliberately NOT
  // pre-baked into the default CORS allowlist until #511's hosted deploy
  // actually exists (ratifies implementation-plan.md's cross-cutting
  // decision + assessment risk 1). This test already passes against the
  // current tree (the default only references OP_CLIENT_PORT/
  // OP_HOST_CLIENT_PORT loopback origins) — it pins the decision so a future
  // "helpful" addition of app.openpalm.dev is a deliberate, test-breaking
  // act rather than a silent widen of the browser-reachable surface.
  test('the default CORS allowlist does not pre-bake the hosted origin (D2, #557 — revisit under #511)', () => {
    const value = String(
      (guardian?.environment as Record<string, unknown> | undefined)?.GUARDIAN_CORS_ALLOWED_ORIGINS ?? '',
    );
    expect(value).not.toContain('app.openpalm.dev');
  });
});
