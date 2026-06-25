/**
 * Route-level tests for GET + PATCH /admin/versions.
 *
 * Pins are STATE (constitution §1): GET reads every version key (Docker image
 * tags) from OP_HOME/state, falling back to the legacy stack.env during the
 * transition window, with documented defaults for unset keys; PATCH validates
 * each key against the SERVICE_VERSION_KEYS allowlist and writes it to the state
 * file. No Docker Hub / npm lookups, no version cache.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { SERVICE_VERSION_KEYS } from '@openpalm/lib';
import { GET, PATCH } from './+server.js';

function stackEnvPath(): string {
  return `${getState().stashDir}/env/stack.env`;
}

/** Pins are STATE now (constitution §1): written to OP_HOME/state, not stack.env. */
function stateEnvPath(): string {
  return `${getState().homeDir}/state/stack.state.env`;
}

function seedStackEnv(content: string): void {
  const path = stackEnvPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    url: new URL('http://localhost/admin/versions'),
    request: new Request('http://localhost/admin/versions', {
      method: 'GET',
      headers: { cookie: `op_session=${token}`, 'x-request-id': 'req-versions-get' },
    }),
  } as Parameters<typeof GET>[0];
}

function makePatchEvent(body: unknown, token = 'admin-token'): Parameters<typeof PATCH>[0] {
  return {
    url: new URL('http://localhost/admin/versions'),
    request: new Request('http://localhost/admin/versions', {
      method: 'PATCH',
      headers: { cookie: `op_session=${token}`, 'content-type': 'application/json', 'x-request-id': 'req-versions-patch' },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof PATCH>[0];
}

type VersionsBody = { versions: Record<string, string>; platformVersion: string };

beforeEach(() => {
  resetState('admin-token');
});

afterEach(() => {
  // resetState builds a fresh temp OP_HOME each run; nothing to undo.
});

describe('GET /admin/versions', () => {
  test('requires admin auth', async () => {
    const res = await GET(makeGetEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns defaults for every version key when stack.env is empty', async () => {
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as VersionsBody;
    for (const key of SERVICE_VERSION_KEYS) {
      expect(body.versions).toHaveProperty(key);
    }
    expect(body.versions.OP_ASSISTANT_VERSION).toBe('latest');
    expect(body.versions.OP_GUARDIAN_VERSION).toBe('latest');
    expect(typeof body.platformVersion).toBe('string');
    expect(body.platformVersion.length).toBeGreaterThan(0);
  });

  test('reflects values written in stack.env', async () => {
    seedStackEnv('OP_ASSISTANT_VERSION=v0.12.18\nOP_PORTAL_VERSION=v0.12.18\n');
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as VersionsBody;
    expect(body.versions.OP_ASSISTANT_VERSION).toBe('v0.12.18');
    expect(body.versions.OP_PORTAL_VERSION).toBe('v0.12.18');
    // Unset keys still fall back to defaults.
    expect(body.versions.OP_GUARDIAN_VERSION).toBe('latest');
  });
});

describe('PATCH /admin/versions', () => {
  test('requires admin auth', async () => {
    const res = await PATCH(makePatchEvent({ versions: { OP_ASSISTANT_VERSION: 'v1' } }, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('rejects a body without a versions object', async () => {
    const res = await PATCH(makePatchEvent({ nope: true }));
    expect(res.status).toBe(400);
  });

  test('rejects unknown version keys', async () => {
    const res = await PATCH(makePatchEvent({ versions: { OP_NOT_A_KEY: 'x' } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown_version_key');
  });

  test('rejects a non-string version value', async () => {
    const res = await PATCH(makePatchEvent({ versions: { OP_ASSISTANT_VERSION: 123 } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_version_value');
  });

  test('writes valid version keys to the state file and echoes the full set', async () => {
    const res = await PATCH(
      makePatchEvent({
        versions: { OP_ASSISTANT_VERSION: 'v0.12.18', OP_PORTAL_VERSION: 'v0.12.18' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; versions: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.versions.OP_ASSISTANT_VERSION).toBe('v0.12.18');
    expect(body.versions.OP_PORTAL_VERSION).toBe('v0.12.18');

    // Persisted to the STATE file (OP_HOME/state), not the legacy stack.env.
    const onDisk = readFileSync(stateEnvPath(), 'utf-8');
    expect(onDisk).toContain('OP_ASSISTANT_VERSION=v0.12.18');
    expect(onDisk).toContain('OP_PORTAL_VERSION=v0.12.18');
  });

  test('writing a pin never touches the legacy stack.env (its keys are left intact)', async () => {
    seedStackEnv('OP_ENABLED_ADDONS=voice\nOP_IMAGE_NAMESPACE=openpalm\n');
    const res = await PATCH(makePatchEvent({ versions: { OP_VOICE_VERSION: 'v0.12.18' } }));
    expect(res.status).toBe(200);
    // The pin lands in the state file…
    expect(readFileSync(stateEnvPath(), 'utf-8')).toContain('OP_VOICE_VERSION=v0.12.18');
    // …and the legacy stack.env is untouched (not rewritten, nothing lost).
    const legacy = readFileSync(stackEnvPath(), 'utf-8');
    expect(legacy).toContain('OP_ENABLED_ADDONS=voice');
    expect(legacy).toContain('OP_IMAGE_NAMESPACE=openpalm');
    expect(legacy).not.toContain('OP_VOICE_VERSION');
  });
});
