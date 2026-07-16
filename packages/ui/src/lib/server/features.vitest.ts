/**
 * Tests for lib/server/features.ts — RuntimeContext v2 (issue #509), after the
 * "One UI, delete the split" refactor: the per-mode capability matrix and the
 * env self-grant are gone. Admin capability is a single boolean —
 * an Electron-or-CLI-only security boundary:
 *   OP_INSIDE_ELECTRON=1 OR OP_ENABLE_ADMIN=1 → adminCapable
 * Every process gets the base capability set; only an adminCapable process
 * additionally gets host:*.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import type { Capability } from '$lib/types.js';
import { computeServerRuntimeContext, computeVoiceRuntime, isAdminCapable } from './features.js';
import { resetState } from '$lib/server/test-helpers.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEvent(url = 'http://127.0.0.1:3880/'): RequestEvent {
  const u = new URL(url);
  return {
    url: u,
    request: new Request(u, { headers: { host: u.host } }),
    params: {},
    locals: {},
    route: { id: '/' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as RequestEvent;
}

/** The full host:* capability set. */
const HOST_CAPS: Capability[] = [
  'host:setup',
  'host:stack:read',
  'host:stack:write',
  'host:containers',
  'host:addons',
  'host:updates',
  'host:logs',
  'host:secrets',
  'host:recovery',
  'host:akm-sharing',
];

/** The base capability set granted to EVERY process. */
const BASE_CAPS: Capability[] = [
  'chat',
  'connections:read',
  'connections:manage',
  'connections:switch',
  'assistant-settings:read',
  'assistant-settings:write',
  'pwa:install',
];

const MODE_ENV_KEYS = ['OP_INSIDE_ELECTRON', 'OP_ENABLE_ADMIN'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of MODE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MODE_ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
});

// ── env → admin mapping ──────────────────────────────────────────────────────

describe('isAdminCapable — Electron-or-CLI-only boundary', () => {
  test('false with no admin env set (served/PWA baseline)', () => {
    expect(isAdminCapable()).toBe(false);
  });

  test('true when OP_INSIDE_ELECTRON=1', () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    expect(isAdminCapable()).toBe(true);
  });

  test('true when OP_ENABLE_ADMIN=1 (local dev / openpalm admin)', () => {
    process.env.OP_ENABLE_ADMIN = '1';
    expect(isAdminCapable()).toBe(true);
  });
});

describe('computeServerRuntimeContext — admin flag reflects the env', () => {
  test('admin=false with no admin env set', () => {
    expect(computeServerRuntimeContext(makeEvent()).admin).toBe(false);
  });

  test('admin=true when OP_INSIDE_ELECTRON=1', () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    expect(computeServerRuntimeContext(makeEvent()).admin).toBe(true);
  });

  test('admin=true when OP_ENABLE_ADMIN=1', () => {
    process.env.OP_ENABLE_ADMIN = '1';
    expect(computeServerRuntimeContext(makeEvent()).admin).toBe(true);
  });
});

// ── contract shape ───────────────────────────────────────────────────────────

describe('computeServerRuntimeContext — ServerRuntimeContext shape', () => {
  test('carries contract version 2', () => {
    expect(computeServerRuntimeContext(makeEvent()).version).toBe(2);
  });

  test('exposes the full contract shape', () => {
    const ctx = computeServerRuntimeContext(makeEvent());
    expect(Array.isArray(ctx.serverCapabilities)).toBe(true);
    expect(typeof ctx.admin).toBe('boolean');
    expect(typeof ctx.publicBaseUrl).toBe('string');
    expect(typeof ctx.uiVersion).toBe('string');
    expect(typeof ctx.skeletonVersion).toBe('string');
    expect(ctx.routes).toBeTypeOf('object');
    expect(typeof ctx.security.hostAdminLoopbackOnly).toBe('boolean');
    expect(typeof ctx.security.requiresHttpsForRemoteConnections).toBe('boolean');
    expect(['loopback-origin', 'same-site']).toContain(ctx.security.csrfMode);
  });

  test('host admin stays loopback-only in an admin process', () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    expect(computeServerRuntimeContext(makeEvent()).security.hostAdminLoopbackOnly).toBe(true);
    delete process.env.OP_INSIDE_ELECTRON;
    process.env.OP_ENABLE_ADMIN = '1';
    expect(computeServerRuntimeContext(makeEvent()).security.hostAdminLoopbackOnly).toBe(true);
  });

  test('non-admin: same-site CSRF + requires HTTPS for remote connections', () => {
    const ctx = computeServerRuntimeContext(makeEvent());
    expect(ctx.security.csrfMode).toBe('same-site');
    expect(ctx.security.requiresHttpsForRemoteConnections).toBe(true);
  });

  test('admin: loopback-origin CSRF + no HTTPS requirement (loopback proxies server-side)', () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const ctx = computeServerRuntimeContext(makeEvent());
    expect(ctx.security.csrfMode).toBe('loopback-origin');
    expect(ctx.security.requiresHttpsForRemoteConnections).toBe(false);
  });

  test('routes: chat + connections always; host + setup only when admin', () => {
    const nonAdmin = computeServerRuntimeContext(makeEvent()).routes;
    expect(nonAdmin.chat).toBe('/chat');
    expect(nonAdmin.connections).toBe('/connections');
    expect(nonAdmin.host).toBeUndefined();
    expect(nonAdmin.setup).toBeUndefined();

    process.env.OP_ENABLE_ADMIN = '1';
    const admin = computeServerRuntimeContext(makeEvent()).routes;
    expect(admin.host).toBe('/host');
    expect(admin.setup).toBe('/setup');
  });
});

// ── serverCapabilities: base everywhere, host:* only when admin ───────────────

describe('computeServerRuntimeContext — serverCapabilities', () => {
  test('a non-admin process has the base capabilities but NO host:*', () => {
    const caps = computeServerRuntimeContext(makeEvent()).serverCapabilities;
    expect(caps).toEqual(expect.arrayContaining(BASE_CAPS));
    for (const hostCap of HOST_CAPS) expect(caps).not.toContain(hostCap);
  });

  test('an adminCapable process (OP_INSIDE_ELECTRON) has base + all host:*', () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    const caps = computeServerRuntimeContext(makeEvent()).serverCapabilities;
    expect(caps).toEqual(expect.arrayContaining([...BASE_CAPS, ...HOST_CAPS]));
  });

  test('an adminCapable process (OP_ENABLE_ADMIN) has base + all host:*', () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const caps = computeServerRuntimeContext(makeEvent()).serverCapabilities;
    expect(caps).toEqual(expect.arrayContaining([...BASE_CAPS, ...HOST_CAPS]));
  });
});

describe('computeVoiceRuntime — voice-endpoint advertisement', () => {
  let homeDir = '';
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.OP_HOME;
    homeDir = join(tmpdir(), `openpalm-voice-rt-${randomBytes(4).toString('hex')}`);
    mkdirSync(homeDir, { recursive: true });
    process.env.OP_HOME = homeDir;
    resetState();
  });

  afterEach(() => {
    process.env.OP_HOME = savedHome;
    rmSync(homeDir, { recursive: true, force: true });
    resetState();
  });

  function enableVoice(env = 'OP_ENABLED_ADDONS=voice\n'): void {
    const envDir = join(homeDir, 'knowledge', 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'stack.env'), env);
  }

  test('absent when the voice addon is not enabled', () => {
    expect(computeVoiceRuntime(makeEvent())).toBeUndefined();
  });

  test('advertises the request host + default port when enabled', () => {
    enableVoice();
    expect(computeVoiceRuntime(makeEvent('http://myhost.lan:3880/'))).toEqual({
      url: 'http://myhost.lan:8880',
    });
  });

  test('honors OP_VOICE_PORT_HOST from stack.env', () => {
    enableVoice('OP_ENABLED_ADDONS=voice\nOP_VOICE_PORT_HOST=9123\n');
    expect(computeVoiceRuntime(makeEvent('http://127.0.0.1:3880/'))).toEqual({
      url: 'http://127.0.0.1:9123',
    });
  });

  test('absent when the event has no url (capability-guard stub events)', () => {
    enableVoice();
    expect(computeVoiceRuntime({} as RequestEvent)).toBeUndefined();
  });
});
