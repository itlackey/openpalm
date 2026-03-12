import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHostInfo, main, reconcileStackEnvImageTag, resolveRequestedImageTag } from './main.ts';

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

});

describe('scan command', () => {
  it('is a recognized command (does not throw Unknown command)', async () => {
    // Verifies 'scan' is in the COMMANDS list and dispatches correctly.
    // Does NOT test full scan behavior (which requires a real varlock binary,
    // secrets.env, and secrets.env.schema). A more complete test would:
    //   - Stage a secrets.env.schema + secrets.env in temp dirs
    //   - Provide a fake varlock binary that echoes its args
    //   - Assert varlock is invoked with 'scan --path <tmpDir>/'
    //   - Verify the temp dir is cleaned up after execution

    const tempStateHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const tempConfigHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const binDir = join(tempStateHome, 'bin');
    const artifactsDir = join(tempStateHome, 'artifacts');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });

    // Create a fake varlock script that exits 0 immediately
    const fakeVarlock = join(binDir, 'varlock');
    writeFileSync(fakeVarlock, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeVarlock, 0o755);

    // Create required files so the command reaches the varlock invocation
    writeFileSync(join(artifactsDir, 'secrets.env.schema'), 'ADMIN_TOKEN\n');
    writeFileSync(join(tempConfigHome, 'secrets.env'), 'ADMIN_TOKEN=testtoken\n');

    const originalStateHome = process.env.OPENPALM_STATE_HOME;
    const originalConfigHome = process.env.OPENPALM_CONFIG_HOME;
    const originalExit = process.exit;
    process.env.OPENPALM_STATE_HOME = tempStateHome;
    process.env.OPENPALM_CONFIG_HOME = tempConfigHome;
    process.exit = mock((_code?: number) => { throw new Error(`process.exit(${_code})`); }) as typeof process.exit;

    try {
      const err = await main(['scan']).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      // Should not be an unknown command error
      expect(message).not.toContain('Unknown command: scan');
      // The fake varlock exits 0, so process.exit(0) should be called
      expect(message).toBe('process.exit(0)');
    } finally {
      process.exit = originalExit;
      process.env.OPENPALM_STATE_HOME = originalStateHome;
      process.env.OPENPALM_CONFIG_HOME = originalConfigHome;
      rmSync(tempStateHome, { recursive: true, force: true });
      rmSync(tempConfigHome, { recursive: true, force: true });
    }
  });

  it('errors when secrets.env.schema is missing', async () => {
    const tempStateHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const tempConfigHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const artifactsDir = join(tempStateHome, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true });

    // secrets.env exists but secrets.env.schema does NOT
    writeFileSync(join(tempConfigHome, 'secrets.env'), 'ADMIN_TOKEN=testtoken\n');

    const originalStateHome = process.env.OPENPALM_STATE_HOME;
    const originalConfigHome = process.env.OPENPALM_CONFIG_HOME;
    const originalExit = process.exit;
    const originalError = console.error;
    const errorCalls: string[] = [];
    process.env.OPENPALM_STATE_HOME = tempStateHome;
    process.env.OPENPALM_CONFIG_HOME = tempConfigHome;
    process.exit = mock((_code?: number) => { throw new Error(`process.exit(${_code})`); }) as typeof process.exit;
    console.error = mock((...args: unknown[]) => { errorCalls.push(args.join(' ')); }) as typeof console.error;

    try {
      const err = await main(['scan']).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe('process.exit(1)');
      expect(errorCalls.some(msg => msg.includes('secrets.env.schema not found'))).toBe(true);
      expect(errorCalls.some(msg => msg.includes('openpalm install'))).toBe(true);
    } finally {
      process.exit = originalExit;
      console.error = originalError;
      process.env.OPENPALM_STATE_HOME = originalStateHome;
      process.env.OPENPALM_CONFIG_HOME = originalConfigHome;
      rmSync(tempStateHome, { recursive: true, force: true });
      rmSync(tempConfigHome, { recursive: true, force: true });
    }
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

describe('install image tag pinning', () => {
  it('normalizes semver refs to image tags', () => {
    expect(resolveRequestedImageTag('0.9.0-rc10')).toBe('v0.9.0-rc10');
    expect(resolveRequestedImageTag('v0.9.0-rc10')).toBe('v0.9.0-rc10');
    expect(resolveRequestedImageTag('main')).toBeNull();
  });

  it('pins existing stack.env image tag to the requested release tag', () => {
    const original = 'OPENPALM_IMAGE_NAMESPACE=openpalm\nOPENPALM_IMAGE_TAG=latest\n';
    expect(reconcileStackEnvImageTag(original, 'v0.9.0-rc10')).toBe(
      'OPENPALM_IMAGE_NAMESPACE=openpalm\nOPENPALM_IMAGE_TAG=v0.9.0-rc10\n',
    );
  });

  it('does not overwrite existing stack.env image tag for main installs', () => {
    const original = 'OPENPALM_IMAGE_NAMESPACE=openpalm\nOPENPALM_IMAGE_TAG=latest\n';
    expect(reconcileStackEnvImageTag(original, 'main')).toBe(original);
  });
});
