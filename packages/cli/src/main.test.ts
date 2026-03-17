import { afterEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHostInfo, main, reconcileStackEnvImageTag, resolveRequestedImageTag, upsertEnvValue } from './main.ts';

// Helpers to mock Bun.spawn and Bun.which for tests that would otherwise
// shell out to `docker info` / `docker compose version` and block in CI.
const originalBunSpawn = Bun.spawn;
const originalBunWhich = Bun.which;

function mockDockerCli(): void {
  Bun.which = mock((_cmd: string) => '/usr/bin/docker') as typeof Bun.which;
  Bun.spawn = mock((_cmd: string[] | readonly string[], _opts?: unknown) => ({
    pid: 0,
    exited: Promise.resolve(0),
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: () => {},
    ref: () => {},
    unref: () => {},
    [Symbol.asyncDispose]: async () => {},
    resourceUsage: () => undefined,
  })) as unknown as typeof Bun.spawn;
}

function restoreDockerCli(): void {
  Bun.spawn = originalBunSpawn;
  Bun.which = originalBunWhich;
}

describe('cli main', () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalConfigHome = process.env.OPENPALM_CONFIG_HOME;
  const originalDataHome = process.env.OPENPALM_DATA_HOME;
  const originalStateHome = process.env.OPENPALM_STATE_HOME;
  const originalWorkDir = process.env.OPENPALM_WORK_DIR;
  const originalAdminToken = process.env.ADMIN_TOKEN;
  const originalOpenPalmAdminToken = process.env.OPENPALM_ADMIN_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    restoreDockerCli();
    process.env.OPENPALM_CONFIG_HOME = originalConfigHome;
    process.env.OPENPALM_DATA_HOME = originalDataHome;
    process.env.OPENPALM_STATE_HOME = originalStateHome;
    process.env.OPENPALM_WORK_DIR = originalWorkDir;
    process.env.ADMIN_TOKEN = originalAdminToken;
    process.env.OPENPALM_ADMIN_TOKEN = originalOpenPalmAdminToken;
  });

  it('calls containers pull for update (via admin when reachable)', async () => {
    const calls: string[] = [];
    process.env.OPENPALM_ADMIN_TOKEN = 'test-token';
    globalThis.fetch = mock(async (input: string | URL) => {
      calls.push(String(input));
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;

    await main(['update']);

    // tryAdminRequest attempts directly — no separate health check
    expect(calls).toEqual([
      'http://localhost:8100/admin/containers/pull',
    ]);
  });

  it('uses ADMIN_TOKEN from the environment for admin requests', async () => {
    const adminTokens: string[] = [];
    process.env.ADMIN_TOKEN = 'env-admin-token';
    delete process.env.OPENPALM_ADMIN_TOKEN;

    globalThis.fetch = mock(async (_input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      adminTokens.push(headers.get('X-Admin-Token') ?? '');
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;

    await main(['update']);

    // Direct request — single call with token header
    expect(adminTokens).toEqual(['env-admin-token']);
  });

  it('falls back to the legacy parent secrets.env for admin requests', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-config-'));
    const configHome = join(base, 'openpalm');
    const adminTokens: string[] = [];

    mkdirSync(configHome, { recursive: true });
    writeFileSync(join(configHome, 'secrets.env'), 'OPENPALM_ADMIN_TOKEN=\nADMIN_TOKEN=\n');
    writeFileSync(join(base, 'secrets.env'), 'export ADMIN_TOKEN="legacy-admin-token"\n');

    process.env.OPENPALM_CONFIG_HOME = configHome;
    delete process.env.ADMIN_TOKEN;
    delete process.env.OPENPALM_ADMIN_TOKEN;

    globalThis.fetch = mock(async (_input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      adminTokens.push(headers.get('X-Admin-Token') ?? '');
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;

    try {
      await main(['update']);
      // Direct request — single call with legacy token
      expect(adminTokens).toEqual(['legacy-admin-token']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('calls admin install when stack is already running and token exists', async () => {
    const calls: string[] = [];
    process.env.OPENPALM_ADMIN_TOKEN = 'test-token';
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
      'http://localhost:8100/health',
      'http://localhost:8100/admin/install',
    ]);
  });

  it('falls back to bootstrap when stack is running but no token exists', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
    const configHome = join(base, 'config');
    const dataHome = join(base, 'data');
    const stateHome = join(base, 'state');
    const workDir = join(base, 'work');
    const binDir = join(stateHome, 'bin');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'varlock'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'varlock'), 0o755);

    process.env.OPENPALM_CONFIG_HOME = configHome;
    process.env.OPENPALM_DATA_HOME = dataHome;
    process.env.OPENPALM_STATE_HOME = stateHome;
    process.env.OPENPALM_WORK_DIR = workDir;
    delete process.env.ADMIN_TOKEN;
    delete process.env.OPENPALM_ADMIN_TOKEN;

    mockDockerCli();
    const fetchedUrls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.endsWith('/health')) {
        return new Response('ok', { status: 200 });
      }
      if (url.includes('/docker-compose.yml')) {
        return new Response('services: {}\n', { status: 200 });
      }
      if (url.includes('/Caddyfile')) {
        return new Response(':80 {\n}\n', { status: 200 });
      }
      if (url.includes('/secrets.env.schema') || url.includes('/stack.env.schema')) {
        return new Response('KEY=string\n', { status: 200 });
      }
      return new Response('', { status: 503 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      await main(['install', '--no-start', '--force', '--no-open']);
      // Should have fallen through to bootstrap, creating directories
      expect(existsSync(join(dataHome, 'admin'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('creates the admin data directory during bootstrap install', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
    const configHome = join(base, 'config');
    const dataHome = join(base, 'data');
    const stateHome = join(base, 'state');
    const workDir = join(base, 'work');
    const binDir = join(stateHome, 'bin');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'varlock'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'varlock'), 0o755);

    process.env.OPENPALM_CONFIG_HOME = configHome;
    process.env.OPENPALM_DATA_HOME = dataHome;
    process.env.OPENPALM_STATE_HOME = stateHome;
    process.env.OPENPALM_WORK_DIR = workDir;

    mockDockerCli();
    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        throw new TypeError('fetch failed');
      }
      if (url.includes('/docker-compose.yml')) {
        return new Response('services: {}\n', { status: 200 });
      }
      if (url.includes('/Caddyfile')) {
        return new Response(':80 {\n}\n', { status: 200 });
      }
      if (url.includes('/secrets.env.schema') || url.includes('/stack.env.schema')) {
        return new Response('KEY=string\n', { status: 200 });
      }
      return new Response('', { status: 503 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;

    try {
      await main(['install', '--no-start', '--force', '--no-open']);
      expect(existsSync(join(dataHome, 'admin'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('uses main as the default install ref for bootstrap asset downloads', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
    const configHome = join(base, 'config');
    const dataHome = join(base, 'data');
    const stateHome = join(base, 'state');
    const workDir = join(base, 'work');
    const binDir = join(stateHome, 'bin');
    const fetchedUrls: string[] = [];

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'varlock'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'varlock'), 0o755);

    process.env.OPENPALM_CONFIG_HOME = configHome;
    process.env.OPENPALM_DATA_HOME = dataHome;
    process.env.OPENPALM_STATE_HOME = stateHome;
    process.env.OPENPALM_WORK_DIR = workDir;

    mockDockerCli();
    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.endsWith('/health')) {
        throw new TypeError('fetch failed');
      }
      if (url.includes('/main/assets/docker-compose.yml')) {
        return new Response('services: {}\n', { status: 200 });
      }
      if (url.includes('/main/assets/Caddyfile')) {
        return new Response(':80 {\n}\n', { status: 200 });
      }
      if (url.includes('/main/assets/secrets.env.schema') || url.includes('/main/assets/stack.env.schema')) {
        return new Response('KEY=string\n', { status: 200 });
      }
      return new Response('', { status: 503 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      await main(['install', '--no-start', '--force', '--no-open']);

      expect(fetchedUrls).toContain(
        'https://raw.githubusercontent.com/itlackey/openpalm/main/assets/docker-compose.yml',
      );
      expect(fetchedUrls).toContain(
        'https://raw.githubusercontent.com/itlackey/openpalm/main/assets/Caddyfile',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('npm bin launcher', () => {
  it('points the published bin to a Bun launcher script instead of a TypeScript source file', () => {
    const cliPkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      bin?: Record<string, string>;
    };

    expect(cliPkg.bin?.openpalm).toBe('./bin/openpalm.js');

    const launcher = readFileSync(new URL('../bin/openpalm.js', import.meta.url), 'utf8');

    expect(launcher.startsWith('#!/usr/bin/env bun\n')).toBe(true);
  });
});

describe('validate command', () => {
  it('is a recognized command (does not throw Unknown command)', async () => {
    const tempStateHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const binDir = join(tempStateHome, 'bin');
    const artifactsDir = join(tempStateHome, 'artifacts');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });

    const fakeVarlock = join(binDir, 'varlock');
    writeFileSync(fakeVarlock, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeVarlock, 0o755);

    const originalStateHome = process.env.OPENPALM_STATE_HOME;
    const originalExit = process.exit;
    process.env.OPENPALM_STATE_HOME = tempStateHome;
    process.exit = mock((_code?: number) => { throw new Error(`process.exit(${_code})`); }) as typeof process.exit;

    try {
      const err = await main(['validate']).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('Unknown command');
    } finally {
      process.exit = originalExit;
      process.env.OPENPALM_STATE_HOME = originalStateHome;
      rmSync(tempStateHome, { recursive: true, force: true });
    }
  });
});

describe('scan command', () => {
  it('is a recognized command (does not throw Unknown command)', async () => {
    const tempStateHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const tempConfigHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const binDir = join(tempStateHome, 'bin');
    const artifactsDir = join(tempStateHome, 'artifacts');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });

    const fakeVarlock = join(binDir, 'varlock');
    writeFileSync(fakeVarlock, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeVarlock, 0o755);

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
      expect(message).not.toContain('Unknown command');
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
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreDockerCli();
  });

  it('returns valid HostInfo structure', async () => {
    mockDockerCli();
    globalThis.fetch = mock(async () => new Response('', { status: 503 })) as typeof fetch;
    const info = await detectHostInfo();
    expect(info).toHaveProperty('platform');
    expect(info).toHaveProperty('arch');
    expect(info).toHaveProperty('docker');
    expect(info).toHaveProperty('ollama');
    expect(info).toHaveProperty('lmstudio');
    expect(info).toHaveProperty('llamacpp');
    expect(info).toHaveProperty('timestamp');
  });

  it('platform and arch match process values', async () => {
    mockDockerCli();
    globalThis.fetch = mock(async () => new Response('', { status: 503 })) as typeof fetch;
    const info = await detectHostInfo();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
  });

  it('HTTP probes handle connection refused gracefully', async () => {
    mockDockerCli();
    globalThis.fetch = mock(async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const info = await detectHostInfo();
    expect(info.ollama.running).toBe(false);
    expect(info.lmstudio.running).toBe(false);
    expect(info.llamacpp.running).toBe(false);
  });
});

describe('install image tag pinning', () => {
  it('normalizes semver refs to image tags', () => {
    expect(resolveRequestedImageTag('0.9.0-rc10')).toBe('v0.9.0-rc10');
    expect(resolveRequestedImageTag('v0.9.0-rc10')).toBe('v0.9.0-rc10');
    expect(resolveRequestedImageTag('main')).toBeNull();
    expect(resolveRequestedImageTag('   ')).toBeNull();
    expect(resolveRequestedImageTag('1.2')).toBeNull();
    expect(resolveRequestedImageTag('v1.x.y')).toBeNull();
    expect(resolveRequestedImageTag('invalid')).toBeNull();
    expect(resolveRequestedImageTag('v1.0.0-rc..10')).toBeNull();
    expect(resolveRequestedImageTag('v1.0.0..1')).toBeNull();
    expect(resolveRequestedImageTag('v1.0.0-rc_10')).toBeNull();
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

  it('prefers an explicit image tag over the requested release ref', () => {
    const original = 'OPENPALM_IMAGE_NAMESPACE=openpalm\nOPENPALM_IMAGE_TAG=latest\n';
    expect(reconcileStackEnvImageTag(original, 'v0.9.0-rc10', 'v9.9.9-test')).toBe(
      'OPENPALM_IMAGE_NAMESPACE=openpalm\nOPENPALM_IMAGE_TAG=v9.9.9-test\n',
    );
  });

  it('updates an existing key in env content', () => {
    expect(upsertEnvValue('OPENPALM_IMAGE_TAG=latest\n', 'OPENPALM_IMAGE_TAG', 'v0.9.0-rc10')).toBe(
      'OPENPALM_IMAGE_TAG=v0.9.0-rc10\n',
    );
  });

  it('inserts a new key into empty env content', () => {
    expect(upsertEnvValue('', 'OPENPALM_IMAGE_TAG', 'v0.9.0-rc10')).toBe(
      'OPENPALM_IMAGE_TAG=v0.9.0-rc10\n',
    );
  });

  it('inserts a new key when the original content lacks a trailing newline', () => {
    expect(upsertEnvValue('OPENPALM_IMAGE_NAMESPACE=openpalm', 'OPENPALM_IMAGE_TAG', 'v0.9.0-rc10')).toBe(
      'OPENPALM_IMAGE_NAMESPACE=openpalm\nOPENPALM_IMAGE_TAG=v0.9.0-rc10\n',
    );
  });

  it('treats regex characters in keys literally when updating env content', () => {
    expect(upsertEnvValue('KEY.WITH-HYPHEN=old\n', 'KEY.WITH-HYPHEN', 'new')).toBe(
      'KEY.WITH-HYPHEN=new\n',
    );
  });

  it('preserves export prefix when upserting a key', () => {
    expect(upsertEnvValue('export OPENPALM_ADMIN_TOKEN=old\n', 'OPENPALM_ADMIN_TOKEN', 'new')).toBe(
      'export OPENPALM_ADMIN_TOKEN=new\n',
    );
  });

  it('upserts without export prefix when original has none', () => {
    expect(upsertEnvValue('OPENPALM_IMAGE_TAG=latest\n', 'OPENPALM_IMAGE_TAG', 'v1.0.0')).toBe(
      'OPENPALM_IMAGE_TAG=v1.0.0\n',
    );
  });
});

describe('secrets.env generation', () => {
  it('generates secrets.env with export prefix and OPENPALM_ADMIN_TOKEN', async () => {
    const { ensureSecrets } = await import('./lib/env.ts');
    const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-secrets-'));

    try {
      await ensureSecrets(tempDir);
      const content = await Bun.file(join(tempDir, 'secrets.env')).text();
      expect(content).toContain('export OPENPALM_ADMIN_TOKEN=');
      expect(content).toContain('export OPENAI_API_KEY=');
      expect(content).toContain('export MEMORY_USER_ID=');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
