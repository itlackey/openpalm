/**
 * Tests for the assistant endpoint store + active resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { _replaceState, getState } from './state.js';
import {
  makeTestState,
  registerCleanup,
  trackDir,
} from './test-helpers.js';
import {
  addEndpoint,
  deleteEndpoint,
  getActiveEndpoint,
  listEndpoints,
  normalizeEndpointUrl,
  setActiveId,
  updateEndpoint,
  validateEndpointUrl,
} from './endpoints.js';

registerCleanup();

const ENV_KEYS = ['OP_OPENCODE_URL', 'OP_ASSISTANT_URL', 'OP_ASSISTANT_PORT', 'OPENCODE_SERVER_PASSWORD'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  const state = makeTestState();
  trackDir(state.dataDir);
  trackDir(state.configDir);
  // Ensure the data and config dirs exist so writes succeed.
  mkdirSync(state.dataDir, { recursive: true });
  mkdirSync(state.configDir, { recursive: true });
  _replaceState(state);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('normalizeEndpointUrl', () => {
  it('accepts http URLs for loopback hosts and strips trailing slash', () => {
    expect(normalizeEndpointUrl('http://127.0.0.1:3800/')).toBe('http://127.0.0.1:3800');
    expect(normalizeEndpointUrl('http://localhost:3800')).toBe('http://localhost:3800');
    expect(normalizeEndpointUrl('http://[::1]:3800')).toBe('http://[::1]:3800');
    expect(normalizeEndpointUrl('http://host.docker.internal:3800')).toBe(
      'http://host.docker.internal:3800',
    );
  });
  it('accepts plain http for remote LAN hosts (LAN-first)', () => {
    expect(normalizeEndpointUrl('http://10.0.0.5:3800')).toBe('http://10.0.0.5:3800');
    expect(normalizeEndpointUrl('http://remote.example:3800')).toBe('http://remote.example:3800');
  });
  it('accepts https URLs (any host)', () => {
    expect(normalizeEndpointUrl('https://api.example.test')).toBe('https://api.example.test');
    expect(normalizeEndpointUrl('https://remote.example:3800')).toBe('https://remote.example:3800');
  });
  it('rejects non-http schemes', () => {
    expect(normalizeEndpointUrl('ftp://example')).toBeNull();
    expect(normalizeEndpointUrl('file:///etc/passwd')).toBeNull();
  });
  it('rejects garbage', () => {
    expect(normalizeEndpointUrl('not a url')).toBeNull();
    expect(normalizeEndpointUrl('')).toBeNull();
  });
});

describe('validateEndpointUrl (discriminated reasons)', () => {
  it('accepts plain http on remote LAN hosts (LAN-first)', () => {
    expect(validateEndpointUrl('http://10.0.0.5:3800')).toEqual({
      ok: true,
      url: 'http://10.0.0.5:3800',
    });
    expect(validateEndpointUrl('http://remote.example:3800')).toEqual({
      ok: true,
      url: 'http://remote.example:3800',
    });
  });
  it('reports invalid_url for garbage', () => {
    expect(validateEndpointUrl('not a url')).toEqual({ ok: false, reason: 'invalid_url' });
  });
  it('reports invalid_scheme for non-http(s) URLs', () => {
    expect(validateEndpointUrl('ftp://example')).toEqual({ ok: false, reason: 'invalid_scheme' });
  });
  it('accepts loopback http and any https', () => {
    expect(validateEndpointUrl('http://127.0.0.1:3800')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:3800',
    });
    expect(validateEndpointUrl('https://remote.example:3800')).toEqual({
      ok: true,
      url: 'https://remote.example:3800',
    });
  });
});

describe('default endpoint synthesis', () => {
  it('falls back to 127.0.0.1:3800 when no env is set', () => {
    const active = getActiveEndpoint();
    expect(active.isDefault).toBe(true);
    expect(active.id).toBe('default');
    expect(active.url).toBe('http://127.0.0.1:3800');
    expect(active.password).toBeUndefined();
  });

  it('reads OP_OPENCODE_URL when set', () => {
    process.env.OP_OPENCODE_URL = 'http://127.0.0.1:3800';
    expect(getActiveEndpoint().url).toBe('http://127.0.0.1:3800');
  });

  it('uses OP_ASSISTANT_PORT to build the default URL', () => {
    process.env.OP_ASSISTANT_PORT = '4800';
    expect(getActiveEndpoint().url).toBe('http://127.0.0.1:4800');
  });

  it('rewrites wildcard bind hosts to loopback for browser-facing default urls', () => {
    process.env.OP_ASSISTANT_URL = 'http://0.0.0.0:4800';
    expect(getActiveEndpoint().url).toBe('http://127.0.0.1:4800');

    process.env.OP_OPENCODE_URL = 'http://[::]:3900/';
    expect(getActiveEndpoint().url).toBe('http://127.0.0.1:3900');
  });

  it('picks up OPENCODE_SERVER_PASSWORD for default', () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'secret';
    expect(getActiveEndpoint().password).toBe('secret');
  });
});

describe('CRUD', () => {
  it('lists default-only when no entries are persisted', () => {
    const list = listEndpoints();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('default');
  });

  it('adds a user endpoint', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'https://10.0.0.5:3800' });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.label).toBe('Remote');
    expect(entry.url).toBe('https://10.0.0.5:3800');

    const list = listEndpoints();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('default');
    expect(list[1].id).toBe(entry.id);
  });

  it('rejects invalid input on add', () => {
    expect(() => addEndpoint({ label: '', url: 'http://x' })).toThrow(/Label/);
    expect(() => addEndpoint({ label: 'x', url: 'nope' })).toThrow(/URL/);
  });

  it('updates label and url', () => {
    const entry = addEndpoint({ label: 'A', url: 'https://10.0.0.1:3800' });
    const updated = updateEndpoint(entry.id, { label: 'B', url: 'https://10.0.0.2:3800' });
    expect(updated.label).toBe('B');
    expect(updated.url).toBe('https://10.0.0.2:3800');
  });

  it('clears password when patch.password === null', () => {
    const entry = addEndpoint({ label: 'A', url: 'https://10.0.0.1:3800', password: 'secret' });
    expect(entry.password).toBe('secret');
    const updated = updateEndpoint(entry.id, { password: null });
    expect(updated.password).toBeUndefined();
  });

  it('leaves password unchanged when patch.password is undefined', () => {
    const entry = addEndpoint({ label: 'A', url: 'https://10.0.0.1:3800', password: 'secret' });
    const updated = updateEndpoint(entry.id, { label: 'B' });
    expect(updated.password).toBe('secret');
  });

  it('cannot edit the default endpoint', () => {
    expect(() => updateEndpoint('default', { label: 'Nope' })).toThrow(/default/);
  });

  it('cannot delete the default endpoint', () => {
    expect(() => deleteEndpoint('default')).toThrow(/default/);
  });

  it('deletes a user endpoint', () => {
    const entry = addEndpoint({ label: 'A', url: 'https://10.0.0.1:3800' });
    deleteEndpoint(entry.id);
    expect(listEndpoints()).toHaveLength(1);
  });
});

describe('active endpoint', () => {
  it('setActiveId switches to a user entry', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'https://10.0.0.5:3800' });
    setActiveId(entry.id);
    const active = getActiveEndpoint();
    expect(active.id).toBe(entry.id);
    expect(active.isDefault).toBe(false);
  });

  it('setActiveId("default") reverts to the env-derived entry', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'https://10.0.0.5:3800' });
    setActiveId(entry.id);
    setActiveId('default');
    expect(getActiveEndpoint().isDefault).toBe(true);
  });

  it('deleting the active entry reverts to default', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'https://10.0.0.5:3800' });
    setActiveId(entry.id);
    deleteEndpoint(entry.id);
    expect(getActiveEndpoint().isDefault).toBe(true);
  });

  it('setActiveId throws for unknown id', () => {
    expect(() => setActiveId('does-not-exist')).toThrow(/not found/);
  });
});

// ── local-electron (Electron-spawned ephemeral OpenCode) ─────────────────────

function writeLocalRuntime(payload: { url: string; password?: string; pid?: number }): string {
  const path = `${getState().dataDir}/local-opencode.runtime.json`;
  mkdirSync(getState().dataDir, { recursive: true });
  writeFileSync(path, JSON.stringify({
    url: payload.url,
    username: 'openpalm',
    password: payload.password,
    pid: payload.pid ?? 12345,
    startedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return path;
}

function removeLocalRuntime(): void {
  const path = `${getState().dataDir}/local-opencode.runtime.json`;
  if (existsSync(path)) unlinkSync(path);
}

describe('local-electron endpoint synthesis', () => {
  afterEach(() => removeLocalRuntime());

  it('is absent when runtime.json does not exist', () => {
    const list = listEndpoints();
    expect(list.some((e) => e.id === 'local-electron')).toBe(false);
  });

  it('is prepended to the list when runtime.json is present', () => {
    writeLocalRuntime({ url: 'http://127.0.0.1:54321', password: 'rand-pw' });
    const list = listEndpoints();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('local-electron');
    expect(list[0].isLocal).toBe(true);
    expect(list[0].isDefault).toBe(false);
    expect(list[0].url).toBe('http://127.0.0.1:54321');
    expect(list[0].password).toBe('rand-pw');
    expect(list[1].id).toBe('default');
  });

  it('coexists with user-added endpoints', () => {
    writeLocalRuntime({ url: 'http://127.0.0.1:54321' });
    addEndpoint({ label: 'Remote', url: 'https://10.0.0.5:3800' });
    const list = listEndpoints();
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe('local-electron');
    expect(list[1].id).toBe('default');
    expect(list[2].label).toBe('Remote');
  });

  it('re-reads runtime.json each call so password rotation is picked up', () => {
    writeLocalRuntime({ url: 'http://127.0.0.1:54321', password: 'first' });
    expect(getActiveEndpoint().password).toBeUndefined(); // default is still active
    setActiveId('local-electron');
    expect(getActiveEndpoint().password).toBe('first');
    // Simulate Electron restart with a new password.
    writeLocalRuntime({ url: 'http://127.0.0.1:54321', password: 'second' });
    expect(getActiveEndpoint().password).toBe('second');
  });

  it('cannot be edited via updateEndpoint', () => {
    writeLocalRuntime({ url: 'http://127.0.0.1:54321' });
    expect(() => updateEndpoint('local-electron', { label: 'Hacked' })).toThrow(/local Electron/);
  });

  it('cannot be deleted via deleteEndpoint', () => {
    writeLocalRuntime({ url: 'http://127.0.0.1:54321' });
    expect(() => deleteEndpoint('local-electron')).toThrow(/local Electron/);
  });

  it('cannot be set active when runtime.json is absent', () => {
    expect(() => setActiveId('local-electron')).toThrow(/not running/);
  });

  it('falls back to default if active is local-electron but runtime.json is gone', () => {
    writeLocalRuntime({ url: 'http://127.0.0.1:54321', password: 'pw' });
    setActiveId('local-electron');
    expect(getActiveEndpoint().id).toBe('local-electron');
    removeLocalRuntime();
    expect(getActiveEndpoint().id).toBe('default');
    expect(getActiveEndpoint().isDefault).toBe(true);
  });

  it('ignores a corrupt runtime.json', () => {
    const path = `${getState().dataDir}/local-opencode.runtime.json`;
    mkdirSync(getState().dataDir, { recursive: true });
    writeFileSync(path, 'not json{', { mode: 0o600 });
    const list = listEndpoints();
    expect(list.some((e) => e.id === 'local-electron')).toBe(false);
  });

  it('ignores a runtime.json without a url', () => {
    const path = `${getState().dataDir}/local-opencode.runtime.json`;
    mkdirSync(getState().dataDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ password: 'x' }), { mode: 0o600 });
    const list = listEndpoints();
    expect(list.some((e) => e.id === 'local-electron')).toBe(false);
  });

  it('is NOT persisted to endpoints.json when set active', () => {
    writeLocalRuntime({ url: 'http://127.0.0.1:54321', password: 'pw' });
    setActiveId('local-electron');
    const raw = readFileSync(`${getState().configDir}/endpoints.json`, 'utf-8');
    const parsed = JSON.parse(raw);
    // activeId pointer is fine — but the synthetic entry itself must not be
    // serialized into the endpoints array.
    expect(parsed.endpoints).toEqual([]);
    expect(parsed.activeId).toBe('local-electron');
  });
});

describe('persistence', () => {
  it('writes endpoints.json with 0600 permissions', () => {
    const entry = addEndpoint({ label: 'A', url: 'https://10.0.0.1:3800', password: 'shh' });
    expect(listEndpoints().find((e) => e.id === entry.id)).toBeDefined();

    const path = `${getState().configDir}/endpoints.json`;
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('"password"');
  });

  it('re-tightens 0600 perms across subsequent writes', () => {
    // First write: create the file via addEndpoint.
    const entry = addEndpoint({ label: 'A', url: 'https://10.0.0.1:3800', password: 'shh' });
    const path = `${getState().configDir}/endpoints.json`;
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // Simulate an out-of-band perms relaxation (e.g. an operator running
    // `chmod 0644` to read the file, or a tar restore that drops modes).
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    // Second write: any update path must re-chmod to 0600. This guards the
    // re-chmod-on-write behavior in endpoints.ts so file modes can't drift
    // open over time.
    updateEndpoint(entry.id, { label: 'B' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('legacy endpoints.json migration (Phase 5)', () => {
  it('moves data/admin/endpoints.json to config/endpoints.json on first read', () => {
    // Seed the legacy file before any read.
    const state = getState();
    const legacyDir = `${state.dataDir}/admin`;
    const legacyPath = `${legacyDir}/endpoints.json`;
    const newPath = `${state.configDir}/endpoints.json`;

    mkdirSync(legacyDir, { recursive: true });
    const payload = {
      activeId: 'legacy-id',
      endpoints: [
        { id: 'legacy-id', label: 'Legacy', url: 'http://10.0.0.9:3800', password: 'shh' },
      ],
    };
    writeFileSync(legacyPath, JSON.stringify(payload), { mode: 0o600 });
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);

    // First read triggers the lazy migration.
    const list = listEndpoints();
    // [default, legacy entry]
    expect(list).toHaveLength(2);
    expect(list[1].id).toBe('legacy-id');
    expect(list[1].label).toBe('Legacy');

    // New path now exists at 0600 with the same content; old path is gone.
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    expect(statSync(newPath).mode & 0o777).toBe(0o600);
    const migrated = JSON.parse(readFileSync(newPath, 'utf-8'));
    expect(migrated).toEqual(payload);
  });
});
