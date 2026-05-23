/**
 * Tests for the assistant endpoint store + active resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
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
  trackDir(state.stateDir);
  // Ensure the state dir exists so writes succeed.
  mkdirSync(state.stateDir, { recursive: true });
  _replaceState(state);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('normalizeEndpointUrl', () => {
  it('accepts http URLs and strips trailing slash', () => {
    expect(normalizeEndpointUrl('http://10.0.0.5:3800/')).toBe('http://10.0.0.5:3800');
  });
  it('accepts https URLs', () => {
    expect(normalizeEndpointUrl('https://api.example.test')).toBe('https://api.example.test');
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

describe('default endpoint synthesis', () => {
  it('falls back to localhost:3800 when no env is set', () => {
    const active = getActiveEndpoint();
    expect(active.isDefault).toBe(true);
    expect(active.id).toBe('default');
    expect(active.url).toBe('http://localhost:3800');
    expect(active.password).toBeUndefined();
  });

  it('reads OP_OPENCODE_URL when set', () => {
    process.env.OP_OPENCODE_URL = 'http://127.0.0.1:3800';
    expect(getActiveEndpoint().url).toBe('http://127.0.0.1:3800');
  });

  it('uses OP_ASSISTANT_PORT to build the default URL', () => {
    process.env.OP_ASSISTANT_PORT = '4800';
    expect(getActiveEndpoint().url).toBe('http://localhost:4800');
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
    const entry = addEndpoint({ label: 'Remote', url: 'http://10.0.0.5:3800' });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.label).toBe('Remote');
    expect(entry.url).toBe('http://10.0.0.5:3800');

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
    const entry = addEndpoint({ label: 'A', url: 'http://10.0.0.1:3800' });
    const updated = updateEndpoint(entry.id, { label: 'B', url: 'http://10.0.0.2:3800' });
    expect(updated.label).toBe('B');
    expect(updated.url).toBe('http://10.0.0.2:3800');
  });

  it('clears password when patch.password === null', () => {
    const entry = addEndpoint({ label: 'A', url: 'http://10.0.0.1:3800', password: 'secret' });
    expect(entry.password).toBe('secret');
    const updated = updateEndpoint(entry.id, { password: null });
    expect(updated.password).toBeUndefined();
  });

  it('leaves password unchanged when patch.password is undefined', () => {
    const entry = addEndpoint({ label: 'A', url: 'http://10.0.0.1:3800', password: 'secret' });
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
    const entry = addEndpoint({ label: 'A', url: 'http://10.0.0.1:3800' });
    deleteEndpoint(entry.id);
    expect(listEndpoints()).toHaveLength(1);
  });
});

describe('active endpoint', () => {
  it('setActiveId switches to a user entry', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'http://10.0.0.5:3800' });
    setActiveId(entry.id);
    const active = getActiveEndpoint();
    expect(active.id).toBe(entry.id);
    expect(active.isDefault).toBe(false);
  });

  it('setActiveId("default") reverts to the env-derived entry', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'http://10.0.0.5:3800' });
    setActiveId(entry.id);
    setActiveId('default');
    expect(getActiveEndpoint().isDefault).toBe(true);
  });

  it('deleting the active entry reverts to default', () => {
    const entry = addEndpoint({ label: 'Remote', url: 'http://10.0.0.5:3800' });
    setActiveId(entry.id);
    deleteEndpoint(entry.id);
    expect(getActiveEndpoint().isDefault).toBe(true);
  });

  it('setActiveId throws for unknown id', () => {
    expect(() => setActiveId('does-not-exist')).toThrow(/not found/);
  });
});

describe('persistence', () => {
  it('writes endpoints.json with 0600 permissions', () => {
    const entry = addEndpoint({ label: 'A', url: 'http://10.0.0.1:3800', password: 'shh' });
    expect(listEndpoints().find((e) => e.id === entry.id)).toBeDefined();

    const path = `${getState().stateDir}/admin/endpoints.json`;
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('"password"');
  });
});
