import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHostInfo, main } from './main.ts';

describe('cli main', () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });

  it('calls containers pull for update', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL) => {
      calls.push(String(input));
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;

    await main(['update']);

    expect(calls).toEqual(['http://localhost:8100/admin/containers/pull']);
  });

  it('calls admin install when stack is already running', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/health')) {
        return new Response('ok', { status: 200 });
      }
      return new Response('{\"ok\":true}', { status: 200 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;

    await main(['install']);

    expect(calls).toEqual([
      'http://127.0.0.1:8100/health',
      'http://localhost:8100/admin/install',
    ]);
  });

  it('throws for unknown command', async () => {
    await expect(main(['nope'])).rejects.toThrow('Unknown command: nope');
  });
});

describe('validate command', () => {
  it('throws "Unknown command" is no longer thrown for validate', async () => {
    // validate is now a known command, so it won't throw Unknown command.
    // It will fail because varlock exits non-zero on a missing env/schema, but that's a different error.
    // We set up a temp state dir with a fake varlock binary that exits immediately to avoid a network download.

    const tempStateHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const binDir = join(tempStateHome, 'bin');
    const artifactsDir = join(tempStateHome, 'artifacts');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });

    // Create a fake varlock script that exits 1 immediately
    const fakeVarlock = join(binDir, 'varlock');
    writeFileSync(fakeVarlock, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeVarlock, 0o755);

    const originalStateHome = process.env.OPENPALM_STATE_HOME;
    const originalExit = process.exit;
    process.env.OPENPALM_STATE_HOME = tempStateHome;
    // Prevent process.exit from terminating the test runner
    process.exit = mock((_code?: number) => { throw new Error(`process.exit(${_code})`); }) as typeof process.exit;

    try {
      const err = await main(['validate']).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('Unknown command: validate');
    } finally {
      process.exit = originalExit;
      process.env.OPENPALM_STATE_HOME = originalStateHome;
      rmSync(tempStateHome, { recursive: true, force: true });
    }
  });

  it('unknown command still throws', async () => {
    await expect(main(['nope'])).rejects.toThrow('Unknown command: nope');
  });
});

describe('detectHostInfo', () => {
  it('returns valid HostInfo structure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response('', { status: 503 })) as typeof fetch;
    try {
      const info = await detectHostInfo();
      expect(info).toHaveProperty('platform');
      expect(info).toHaveProperty('arch');
      expect(info).toHaveProperty('docker');
      expect(info).toHaveProperty('ollama');
      expect(info).toHaveProperty('lmstudio');
      expect(info).toHaveProperty('llamacpp');
      expect(info).toHaveProperty('timestamp');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('platform and arch match process values', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response('', { status: 503 })) as typeof fetch;
    try {
      const info = await detectHostInfo();
      expect(info.platform).toBe(process.platform);
      expect(info.arch).toBe(process.arch);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('HTTP probes handle connection refused gracefully', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    try {
      const info = await detectHostInfo();
      expect(info.ollama.running).toBe(false);
      expect(info.lmstudio.running).toBe(false);
      expect(info.llamacpp.running).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
