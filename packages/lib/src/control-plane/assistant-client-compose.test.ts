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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const STACK_DIR = join(REPO_ROOT, 'packages/skeleton/system/stack');

type ComposeService = {
  ports?: unknown[];
  environment?: Record<string, unknown> | string[];
  volumes?: unknown[];
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
