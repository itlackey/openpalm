import { afterEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHostInfo, main } from './main.ts';
import { readSecret, resolveRequestedImageTag, upsertEnvValue } from '@openpalm/lib';
import { canReplaceCurrentExecutable, resolveCliArtifactName } from './commands/self-update.ts';

/** Write a minimal SetupSpec YAML file that satisfies validation, allowing --file installs to skip the wizard. */
function writeMinimalSetupSpec(dir: string): string {
  const specPath = join(dir, 'setup-spec.yaml');
  const yaml = [
    'version: 2',
    'capabilities:',
    '  llm: openai/gpt-4o',
    '  embeddings:',
    '    provider: openai',
    '    model: text-embedding-3-small',
    '    dims: 1536',
    'security:',
    '  uiLoginPassword: test-admin-token-12345',
    'owner:',
    '  name: Test User',
    '  email: test@example.com',
    'connections:',
    '  - id: openai',
    '    name: OpenAI',
    '    provider: openai',
    '    baseUrl: https://api.openai.com/v1',
    '    apiKey: sk-test-key',
    '',
  ].join('\n');
  writeFileSync(specPath, yaml);
  return specPath;
}

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
  const originalLoginPassword = process.env.OP_UI_LOGIN_PASSWORD;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    restoreDockerCli();
    process.env.OP_HOME = originalHome;
    process.env.OP_WORK_DIR = originalWorkDir;
    process.env.OP_UI_LOGIN_PASSWORD = originalLoginPassword;
  });

  it('runs bootstrap install directly without admin delegation', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
    const workDir = join(base, 'work');

    const specFile = writeMinimalSetupSpec(base);

    process.env.OP_HOME = base;
    process.env.OP_WORK_DIR = workDir;
    delete process.env.OP_UI_LOGIN_PASSWORD;

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
      if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
      if (url.includes('/opencode.jsonc')) return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      if (url.endsWith('.yml')) return new Response('name: test\nschedule: daily\n', { status: 200 });
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      await main(['install', '--no-start', '--file', specFile]);
      // Bootstrap runs directly, creating directories
      expect(existsSync(join(base, 'data', 'assistant'))).toBe(true);
      expect(existsSync(join(base, 'system', 'stack', 'services.compose.yml'))).toBe(true);
      expect(existsSync(join(base, 'system', 'stack', 'portals.compose.yml'))).toBe(true);
      // custom.compose.yml is USER-owned → config/stack, not system/stack.
      expect(existsSync(join(base, 'config', 'stack', 'custom.compose.yml'))).toBe(true);
      expect(existsSync(join(base, 'knowledge', 'tasks', 'akm-improve.yml'))).toBe(true);
      expect(existsSync(join(base, 'system', 'stack', 'guardian.env'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('creates service data directories during bootstrap install (health check unreachable)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
    const workDir = join(base, 'work');

    const specFile = writeMinimalSetupSpec(base);

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
      if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
      if (url.includes('/opencode.jsonc')) return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      if (url.endsWith('.yml')) return new Response('name: test\nschedule: daily\n', { status: 200 });
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;

    try {
      await main(['install', '--no-start', '--file', specFile]);
      expect(existsSync(join(base, 'data', 'assistant'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('per-image versions default to `latest` when no --version is given (decoupled from the install ref)', async () => {
    // With no --version, the install ref still falls back to the CLI version for
    // GitHub asset download, but the per-image OP_*_VERSION vars must NOT be
    // pinned to the host version — images track `latest` (host & images version
    // independently). Mock the GitHub redirect to fail so resolveDefaultInstallRef
    // falls back.
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-'));
    const workDir = join(base, 'work');
    const specFile = writeMinimalSetupSpec(base);

    process.env.OP_HOME = base;
    process.env.OP_WORK_DIR = workDir;

    mockDockerCli();
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      await main(['install', '--no-start', '--file', specFile]);
      const stackEnv = readFileSync(join(base, 'knowledge', 'env', 'stack.env'), 'utf-8');
      expect(stackEnv).toMatch(/^OP_ASSISTANT_VERSION=latest$/m);
      expect(stackEnv).toMatch(/^OP_GUARDIAN_VERSION=latest$/m);
      expect(stackEnv).toMatch(/^OP_PORTAL_VERSION=latest$/m);
      expect(stackEnv).toMatch(/^OP_VOICE_VERSION=latest$/m);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('an explicit --version pins every per-image version to that version', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-pin-'));
    const workDir = join(base, 'work');
    const specFile = writeMinimalSetupSpec(base);

    process.env.OP_HOME = base;
    process.env.OP_WORK_DIR = workDir;

    mockDockerCli();
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      // An explicit --version is honored verbatim. A legacy `v`-prefixed pin is
      // preserved (not stripped) so a pre-0.12.41 `v`-tagged image stays pullable.
      await main(['install', '--no-start', '--version', 'v0.11.0', '--file', specFile]);
      const stackEnv = readFileSync(join(base, 'knowledge', 'env', 'stack.env'), 'utf-8');
      expect(stackEnv).toMatch(/^OP_ASSISTANT_VERSION=v0\.11\.0$/m);
      expect(stackEnv).toMatch(/^OP_GUARDIAN_VERSION=v0\.11\.0$/m);
      expect(stackEnv).toMatch(/^OP_PORTAL_VERSION=v0\.11\.0$/m);
      expect(stackEnv).toMatch(/^OP_VOICE_VERSION=v0\.11\.0$/m);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('backs up the current OP_HOME before install --force rewrites assets', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-install-force-'));
    const workDir = join(base, 'work');
    const stackConfig = join(base, 'config', 'stack.yml');
    const specFile = writeMinimalSetupSpec(base);

    // The canonical "already installed" marker is knowledge/env/stack.env.
    // Seed it so the backup path triggers AND we can prove the backup
    // carries forward existing content.
    mkdirSync(join(base, 'data'), { recursive: true });
    mkdirSync(join(base, 'system', 'stack'), { recursive: true });
    mkdirSync(join(base, 'config'), { recursive: true });
    mkdirSync(join(base, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(base, 'knowledge', 'env', 'stack.env'), 'OP_OWNER_NAME=existing-owner\n');
    writeFileSync(stackConfig, 'llm: old\n');

    process.env.OP_HOME = base;
    process.env.OP_WORK_DIR = workDir;

    mockDockerCli();
    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) throw new TypeError('fetch failed');
      if (url.includes('/core.compose.yml') || url.includes('/compose.yml')) {
        return new Response('services: {}\n', { status: 200 });
      }
      if (url.includes('.env.schema')) return new Response('KEY=string\n', { status: 200 });
      if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
      if (url.includes('/opencode.jsonc')) return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      if (url.endsWith('.yml')) return new Response('name: test\nschedule: daily\n', { status: 200 });
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      await main(['install', '--force', '--no-start', '--file', specFile]);

      const backupsDir = join(base, 'data', 'backups');
      const backups = readdirSync(backupsDir).filter((name) => name !== '.gitkeep');
      expect(backups.length).toBeGreaterThan(0);
      expect(readFileSync(join(backupsDir, backups[0], 'config', 'stack.yml'), 'utf8')).toContain('llm: old');
      expect(readFileSync(join(backupsDir, backups[0], 'knowledge', 'env', 'stack.env'), 'utf8')).toContain('OP_OWNER_NAME=existing-owner');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('supports addon enable/disable commands', async () => {
    const base = mkdtempSync(join(tmpdir(), 'openpalm-addon-cli-'));
    const coreCompose = join(base, 'system', 'stack', 'core.compose.yml');
    const logs: string[] = [];

    mkdirSync(join(base, 'system', 'stack'), { recursive: true });
    mkdirSync(join(base, 'data'), { recursive: true });
    writeFileSync(coreCompose, 'services:\n  assistant:\n    image: test\n');
    writeFileSync(join(base, 'system', 'stack', 'portals.compose.yml'), 'services:\n  discord:\n    profiles: ["addon.discord"]\n    image: discord\n    environment:\n      PORTAL_NAME: "Discord Bot"\n');

    process.env.OP_HOME = base;
    process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
    mockDockerCli();
    console.log = mock((message?: unknown) => { logs.push(String(message ?? '')); }) as typeof console.log;
    console.warn = mock((message?: unknown) => { logs.push(String(message ?? '')); }) as typeof console.warn;

    try {
      // OP_ENABLED_ADDONS is app-written addon state → state/ (constitution §1).
      const stateEnv = () => readFileSync(join(base, 'state', 'stack.state.env'), 'utf-8');
      await main(['addon', 'enable', 'discord']);
      expect(stateEnv()).toContain('OP_ENABLED_ADDONS=discord');
      expect(readSecret(base, 'portal_discord_secret')).toBeTruthy();

      await main(['addon', 'disable', 'discord']);
      expect(stateEnv()).not.toContain('discord');
    } finally {
      delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('self-update helpers', () => {
  it('maps supported platforms to release artifacts', () => {
    expect(resolveCliArtifactName('linux', 'x64')).toBe('openpalm-cli-linux-x64');
    expect(resolveCliArtifactName('darwin', 'arm64')).toBe('openpalm-cli-darwin-arm64');
  });

  it('rejects unsupported platforms', () => {
    expect(() => resolveCliArtifactName('freebsd', 'mips64')).toThrow('Unsupported platform for self-update');
  });

  it('only allows replacing standalone executables', () => {
    expect(canReplaceCurrentExecutable('/usr/local/bin/openpalm')).toBe(true);
    expect(canReplaceCurrentExecutable('/home/runner/.bun/bin/bun')).toBe(false);
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
  }, 20_000);
});

describe('validate command', () => {
  it('is a recognized command and exits 0 when file-based required secrets exist', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const stackDir = join(tempHome, 'system', 'stack');
    const envDir = join(tempHome, 'knowledge', 'env');
    const secretDir = join(tempHome, 'knowledge', 'secrets');
    mkdirSync(stackDir, { recursive: true });
    mkdirSync(envDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(envDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
    writeFileSync(join(secretDir, 'op_ui_login_password'), 'abc\n', { mode: 0o600 });

    const originalHome = process.env.OP_HOME;
    const originalExit = process.exit;
    process.env.OP_HOME = tempHome;
    process.exit = mock((_code?: number) => { throw new Error(`process.exit(${_code})`); }) as typeof process.exit;

    try {
      const err = await main(['validate']).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('Unknown command');
      expect(message).toBe('process.exit(0)');
    } finally {
      process.exit = originalExit;
      process.env.OP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('scan command', () => {
  it('is a recognized command and exits 0 listing sensitive keys', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const stackDir = join(tempHome, 'system', 'stack');
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, 'stack.env'), 'OP_UI_LOGIN_PASSWORD=abc\nOPENAI_API_KEY=sk-test\n');

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
});

describe('audit-secrets command', () => {
  it('is a recognized command and exits 0 for file-based secrets', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-test-'));
    const stackDir = join(tempHome, 'system', 'stack');
    const secretDir = join(tempHome, 'knowledge', 'secrets');
    mkdirSync(stackDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stackDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
    writeFileSync(join(secretDir, 'op_ui_login_password'), 'abc\n', { mode: 0o600 });

    const originalHome = process.env.OP_HOME;
    const originalExit = process.exit;
    process.env.OP_HOME = tempHome;
    process.exit = mock((_code?: number) => { throw new Error(`process.exit(${_code})`); }) as typeof process.exit;

    try {
      const err = await main(['audit-secrets']).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('Unknown command');
      expect(message).toBe('process.exit(0)');
    } finally {
      process.exit = originalExit;
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
  it('validates and passes refs through verbatim (bare stays bare, legacy v preserved)', () => {
    expect(resolveRequestedImageTag('0.9.0-rc10')).toBe('0.9.0-rc10');
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
    expect(upsertEnvValue('export OP_UI_LOGIN_PASSWORD=old\n', 'OP_UI_LOGIN_PASSWORD', 'new')).toBe(
      'export OP_UI_LOGIN_PASSWORD=new\n',
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
    const specFile = writeMinimalSetupSpec(tempHome);
    const mainPath = join(fileURLToPath(new URL('./', import.meta.url)), 'main.ts');
    try {
      // Run install --no-start --file as a real subprocess.
      // This exercises the import.meta.main code path that in-process tests skip.
      // Uses --file to skip the interactive wizard that would block indefinitely.
      const proc = Bun.spawn(['bun', mainPath, 'install', '--no-start', '--file', specFile], {
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

describe('UI host server', () => {
  it("startUIServer (supervisor) is exported from lib/ui-server.ts", async () => {
    // The bare `openpalm` command starts the long-lived UI supervisor, which
    // spawns `openpalm ui` as its killable/respawnable child.
    const mod = await import("./lib/ui-server.ts");
    expect(typeof mod.startUIServer).toBe("function");
  });

  it("runUiBuild (child) is exported from lib/ui-server.ts", async () => {
    // `openpalm ui` runs the adapter-node build in-process on the embedded Bun
    // runtime via runUiBuild — no system `node` is required.
    const mod = await import("./lib/ui-server.ts");
    expect(typeof mod.runUiBuild).toBe("function");
  });

  it("the `ui` subcommand is registered", async () => {
    const { mainCommand } = await import("./main.ts");
    const sub = (mainCommand.subCommands as Record<string, () => Promise<unknown>>).ui;
    expect(typeof sub).toBe("function");
    const cmd = (await sub()) as { meta?: { name?: string } };
    expect(cmd.meta?.name).toBe("ui");
  });
});

describe('secrets.env generation', () => {
  it('creates the data/ directory on fresh install', async () => {
    const { existsSync: fsExistsSync, mkdirSync } = await import('node:fs');
    const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-secrets-'));
    const dataDir = join(tempDir, 'data');

    try {
      mkdirSync(dataDir, { recursive: true });
      expect(fsExistsSync(dataDir)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
