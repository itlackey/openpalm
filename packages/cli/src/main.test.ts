import { afterEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHostInfo, main, reconcileStackEnvImageTag, resolveRequestedImageTag, upsertEnvValue } from './main.ts';

const TAR_BLOCK_SIZE = 512;

async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return Uint8Array.from(Bun.gunzipSync(Uint8Array.from(data)));
}

function readTarEntry(archive: Uint8Array, entryName: string): Uint8Array | null {
  for (let offset = 0; offset + TAR_BLOCK_SIZE <= archive.length; offset += TAR_BLOCK_SIZE) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      return null;
    }

    const rawName = new TextDecoder().decode(header.subarray(0, 100));
    const name = rawName.replace(/\0.*$/, '');
    const rawSize = new TextDecoder().decode(header.subarray(124, 136));
    const size = Number.parseInt(rawSize.replace(/\0.*$/, '').trim() || '0', 8);
    const contentOffset = offset + TAR_BLOCK_SIZE;
    const contentEnd = contentOffset + size;

    if (name === entryName) {
      return archive.slice(contentOffset, contentEnd);
    }

    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return null;
}

async function readPackedPackageJson(tarballPath: string): Promise<{ dependencies?: Record<string, string> }> {
  const compressed = new Uint8Array(await Bun.file(tarballPath).arrayBuffer());
  const archive = await gunzipBytes(compressed);
  const packageJson = readTarEntry(archive, 'package/package.json');
  if (!packageJson) {
    throw new Error('Expected packed tarball to include package/package.json');
  }

  return JSON.parse(new TextDecoder().decode(packageJson)) as {
    dependencies?: Record<string, string>;
  };
}

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
  const originalHome = process.env.OP_HOME;
  const originalWorkDir = process.env.OP_WORK_DIR;
  const originalAdminToken = process.env.OP_ADMIN_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    restoreDockerCli();
    process.env.OP_HOME = originalHome;
    process.env.OP_WORK_DIR = originalWorkDir;
    process.env.OP_ADMIN_TOKEN = originalAdminToken;
  });

  it('runs bootstrap install directly without admin delegation', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
    const configHome = join(base, 'config');
    const dataHome = join(base, 'data');
    const workDir = join(base, 'work');
    const binDir = join(base, 'data', 'bin');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'varlock'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'varlock'), 0o755);

    process.env.OP_HOME = base;
    process.env.OP_WORK_DIR = workDir;
    delete process.env.OP_ADMIN_TOKEN;

    mockDockerCli();
    const fetchedUrls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.endsWith('/health')) {
        return new Response('ok', { status: 200 });
      }
      if (url.includes('/core.compose.yml') || url.includes('/compose.yml')) {
        return new Response('services: {}\n', { status: 200 });
      }
      if (url.includes('.env.schema')) {
        return new Response('KEY=string\n', { status: 200 });
      }
      if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
      if (url.includes('/opencode.jsonc')) return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      if (url.endsWith('.yml')) return new Response('name: test\nschedule: daily\n', { status: 200 });
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      await main(['install', '--no-start', '--force', '--no-open']);
      // Bootstrap runs directly, creating directories
      expect(existsSync(join(dataHome, 'admin'))).toBe(true);
      // guardian.env must be a file (not directory) — Docker creates a directory
      // when bind-mounting a non-existent source path, breaking compose up.
      const guardianEnv = join(base, 'vault', 'stack', 'guardian.env');
      expect(existsSync(guardianEnv)).toBe(true);
      expect(statSync(guardianEnv).isFile()).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('creates the admin data directory during bootstrap install', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
    const dataHome = join(base, 'data');
    const workDir = join(base, 'work');
    const binDir = join(base, 'data', 'bin');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'varlock'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'varlock'), 0o755);

    process.env.OP_HOME = base;
    process.env.OP_WORK_DIR = workDir;

    mockDockerCli();
    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        throw new TypeError('fetch failed');
      }
      if (url.includes('/core.compose.yml') || url.includes('/compose.yml')) {
        return new Response('services: {}\n', { status: 200 });
      }
      if (url.includes('.env.schema')) {
        return new Response('KEY=string\n', { status: 200 });
      }
      if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
      if (url.includes('/opencode.jsonc')) return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      if (url.endsWith('.yml')) return new Response('name: test\nschedule: daily\n', { status: 200 });
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;

    try {
      await main(['install', '--no-start', '--force', '--no-open']);
      expect(existsSync(join(dataHome, 'admin'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('resolves version-pinned install ref (falls back to CLI package version)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
    const workDir = join(base, 'work');
    const binDir = join(base, 'data', 'bin');
    const fetchedUrls: string[] = [];

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'varlock'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'varlock'), 0o755);

    process.env.OP_HOME = base;
    process.env.OP_WORK_DIR = workDir;

    // Read the CLI package version to verify pinning behaviour
    const cliPkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const expectedRef = `v${cliPkg.version}`;

    mockDockerCli();
    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.endsWith('/health')) {
        throw new TypeError('fetch failed');
      }
      // Respond to version-pinned asset URLs
      if (url.includes('/core.compose.yml') || url.includes('/compose.yml')) {
        return new Response('services: {}\n', { status: 200 });
      }
      if (url.includes('.env.schema')) {
        return new Response('KEY=string\n', { status: 200 });
      }
      if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
      if (url.includes('/opencode.jsonc')) return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      if (url.endsWith('.yml')) return new Response('name: test\nschedule: daily\n', { status: 200 });
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      await main(['install', '--no-start', '--force', '--no-open']);

      // Verify that assets were fetched using the version-pinned ref, not 'main'
      const composeUrl = fetchedUrls.find((u) => u.includes('/core.compose.yml'));
      expect(composeUrl).toBeDefined();
      expect(composeUrl).toContain(expectedRef);
      expect(composeUrl).not.toContain('/main/');
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

  it('packs a real semver range for @openpalm/lib so published installs can resolve the latest compatible lib', async () => {
    const cliPkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
    };
    const libPkg = JSON.parse(
      readFileSync(new URL('../../lib/package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
    };
    const versionMatch = libPkg.version.match(/^(\d+)\.\d+\.\d+(?:-.+)?$/);
    if (!versionMatch) throw new Error(`Unexpected lib version format: ${libPkg.version}`);
    const libMajor = Number.parseInt(versionMatch[1], 10);

    const expectedRange = `>=${libPkg.version} <${libMajor + 1}.0.0`;

    expect(cliPkg.dependencies?.['@openpalm/lib']).toBe(expectedRange);

    const packageDir = fileURLToPath(new URL('../', import.meta.url));
    const packDir = mkdtempSync(join(tmpdir(), 'openpalm-cli-pack-'));

    try {
      const pack = Bun.spawnSync(
        [process.execPath, 'pm', 'pack', '--destination', packDir, '--quiet'],
        {
          cwd: packageDir,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      expect(pack.exitCode).toBe(0);

      const tarball = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
      if (!tarball) throw new Error('Expected bun pm pack to produce a tarball');

      const packedPkg = await readPackedPackageJson(join(packDir, tarball));

      expect(packedPkg.dependencies?.['@openpalm/lib']).toBe(expectedRange);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});

describe('validate command', () => {
  it('is a recognized command (does not throw Unknown command)', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const binDir = join(tempHome, 'data', 'bin');
    const artifactsDir = join(tempHome, 'data', 'artifacts');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });

    const fakeVarlock = join(binDir, 'varlock');
    writeFileSync(fakeVarlock, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeVarlock, 0o755);

    const originalHome = process.env.OP_HOME;
    const originalExit = process.exit;
    process.env.OP_HOME = tempHome;
    process.exit = mock((_code?: number) => { throw new Error(`process.exit(${_code})`); }) as typeof process.exit;

    try {
      const err = await main(['validate']).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('Unknown command');
    } finally {
      process.exit = originalExit;
      process.env.OP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('scan command', () => {
  it('is a recognized command (does not throw Unknown command)', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const binDir = join(tempHome, 'data', 'bin');
    const artifactsDir = join(tempHome, 'data', 'artifacts');
    const vaultDir = join(tempHome, 'vault');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });
    mkdirSync(vaultDir, { recursive: true });

    const fakeVarlock = join(binDir, 'varlock');
    writeFileSync(fakeVarlock, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeVarlock, 0o755);

    mkdirSync(join(vaultDir, 'user'), { recursive: true });
    writeFileSync(join(vaultDir, 'user', 'user.env.schema'), 'ADMIN_TOKEN\n');
    writeFileSync(join(vaultDir, 'user', 'user.env'), 'ADMIN_TOKEN=testtoken\n');

    const originalHome = process.env.OP_HOME;
    const originalExit = process.exit;
    process.env.OP_HOME = tempHome;
    process.exit = mock((_code?: number) => { throw new Error(`process.exit(${_code})`); }) as typeof process.exit;

    try {
      const err = await main(['scan']).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('Unknown command');
      expect(message).toBe('process.exit(0)');
    } finally {
      process.exit = originalExit;
      process.env.OP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('errors when user.env.schema is missing', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const artifactsDir = join(tempHome, 'data', 'artifacts');
    const vaultDir = join(tempHome, 'vault');
    mkdirSync(artifactsDir, { recursive: true });
    mkdirSync(join(vaultDir, 'user'), { recursive: true });

    writeFileSync(join(vaultDir, 'user', 'user.env'), 'ADMIN_TOKEN=testtoken\n');

    const originalHome = process.env.OP_HOME;
    const originalExit = process.exit;
    const originalError = console.error;
    const errorCalls: string[] = [];
    process.env.OP_HOME = tempHome;
    process.exit = mock((_code?: number) => { throw new Error(`process.exit(${_code})`); }) as typeof process.exit;
    console.error = mock((...args: unknown[]) => { errorCalls.push(args.join(' ')); }) as typeof console.error;

    try {
      const err = await main(['scan']).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toBe('process.exit(1)');
      expect(errorCalls.some(msg => msg.includes('user.env.schema not found'))).toBe(true);
      expect(errorCalls.some(msg => msg.includes('openpalm install'))).toBe(true);
    } finally {
      process.exit = originalExit;
      console.error = originalError;
      process.env.OP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
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
    globalThis.fetch = mock(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
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
    globalThis.fetch = mock(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const info = await detectHostInfo();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
  });

  it('HTTP probes handle connection refused gracefully', async () => {
    mockDockerCli();
    globalThis.fetch = mock(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
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
    const original = 'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=latest\n';
    expect(reconcileStackEnvImageTag(original, 'v0.9.0-rc10')).toBe(
      'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.9.0-rc10\n',
    );
  });

  it('does not overwrite existing stack.env image tag for main installs', () => {
    const original = 'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=latest\n';
    expect(reconcileStackEnvImageTag(original, 'main')).toBe(original);
  });

  it('prefers an explicit image tag over the requested release ref', () => {
    const original = 'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=latest\n';
    expect(reconcileStackEnvImageTag(original, 'v0.9.0-rc10', 'v9.9.9-test')).toBe(
      'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v9.9.9-test\n',
    );
  });

  it('updates an existing key in env content', () => {
    expect(upsertEnvValue('OP_IMAGE_TAG=latest\n', 'OP_IMAGE_TAG', 'v0.9.0-rc10')).toBe(
      'OP_IMAGE_TAG=v0.9.0-rc10\n',
    );
  });

  it('inserts a new key into empty env content', () => {
    expect(upsertEnvValue('', 'OP_IMAGE_TAG', 'v0.9.0-rc10')).toBe(
      'OP_IMAGE_TAG=v0.9.0-rc10\n',
    );
  });

  it('inserts a new key when the original content lacks a trailing newline', () => {
    expect(upsertEnvValue('OP_IMAGE_NAMESPACE=openpalm', 'OP_IMAGE_TAG', 'v0.9.0-rc10')).toBe(
      'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.9.0-rc10\n',
    );
  });

  it('treats regex characters in keys literally when updating env content', () => {
    expect(upsertEnvValue('KEY.WITH-HYPHEN=old\n', 'KEY.WITH-HYPHEN', 'new')).toBe(
      'KEY.WITH-HYPHEN=new\n',
    );
  });

  it('preserves export prefix when upserting a key', () => {
    expect(upsertEnvValue('export OP_ADMIN_TOKEN=old\n', 'OP_ADMIN_TOKEN', 'new')).toBe(
      'export OP_ADMIN_TOKEN=new\n',
    );
  });

  it('upserts without export prefix when original has none', () => {
    expect(upsertEnvValue('OP_IMAGE_TAG=latest\n', 'OP_IMAGE_TAG', 'v1.0.0')).toBe(
      'OP_IMAGE_TAG=v1.0.0\n',
    );
  });
});

describe('cli entrypoint (subprocess)', () => {
  it('produces output when run as a subprocess (catches missing top-level await)', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-entry-'));
    const workDir = join(tempHome, 'work');
    mkdirSync(workDir, { recursive: true });
    const mainPath = join(fileURLToPath(new URL('./', import.meta.url)), 'main.ts');
    try {
      // Run install --no-start --no-open as a real subprocess with mocked docker/fetch.
      // This exercises the import.meta.main code path that in-process tests skip.
      const proc = Bun.spawn(['bun', mainPath, 'install', '--no-start', '--no-open', '--force'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, OP_HOME: tempHome, OP_WORK_DIR: workDir },
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      // The process must produce output — silent exit 0 was the bug
      expect(stdout.length + stderr.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('secrets.env generation', () => {
  it('generates user.env with export prefix and user-managed keys', async () => {
    const { ensureSecrets } = await import('./lib/env.ts');
    const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-secrets-'));
    const vaultDir = join(tempDir, 'vault');
    mkdirSync(vaultDir, { recursive: true });

    try {
      await ensureSecrets(vaultDir);
      const content = await Bun.file(join(vaultDir, 'user', 'user.env')).text();
      expect(content).toContain('export OPENAI_API_KEY=');
      expect(content).toContain('export MEMORY_USER_ID=');
      // System secrets (OP_ADMIN_TOKEN, OP_MEMORY_TOKEN) belong in stack.env, not user.env
      expect(content).not.toContain('OP_ADMIN_TOKEN');
      expect(content).not.toContain('OP_MEMORY_TOKEN');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
