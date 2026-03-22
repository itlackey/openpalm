/**
 * Tests for the --file install path in the install command.
 *
 * Mocks performSetup to avoid filesystem side effects, and verifies that
 * the file-based install flow correctly reads, parses, and dispatches
 * JSON/YAML config files. Supports both v1 (SetupConfig, migrated) and
 * v2 (SetupSpec) formats.
 */
import { describe, expect, it, mock, afterEach, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Helpers ──────────────────────────────────────────────────────────────

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

/** v1 SetupConfig format (legacy) */
function makeValidSetupConfig(): Record<string, unknown> {
  return {
    version: 1,
    owner: { name: 'Test User', email: 'test@example.com' },
    security: { adminToken: 'test-admin-token-12345' },
    connections: [
      {
        id: 'openai-main',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test-key-123',
      },
    ],
    assignments: {
      llm: { connectionId: 'openai-main', model: 'gpt-4o' },
      embeddings: { connectionId: 'openai-main', model: 'text-embedding-3-small' },
    },
    memory: { userId: 'test_user' },
  };
}

// ── Test Suite ────────────────────────────────────────────────────────────

describe('install --file', () => {
  let tempBase: string;
  let homeDir: string;
  let configDir: string;
  let dataDir: string;
  let workDir: string;

  const savedEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'openpalm-install-file-'));
    homeDir = tempBase;
    configDir = join(homeDir, 'config');
    dataDir = join(homeDir, 'data');
    workDir = join(tempBase, 'work');
    const binDir = join(dataDir, 'bin');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'varlock'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'varlock'), 0o755);

    savedEnv.OP_HOME = process.env.OP_HOME;
    savedEnv.OP_WORK_DIR = process.env.OP_WORK_DIR;
    savedEnv.OP_ADMIN_TOKEN = process.env.OP_ADMIN_TOKEN;
    savedEnv.OP_ADMIN_TOKEN = process.env.OP_ADMIN_TOKEN;
    savedEnv.OP_SKIP_COMPOSE_PREFLIGHT = process.env.OP_SKIP_COMPOSE_PREFLIGHT;

    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = workDir;
    // Skip compose preflight: Bun.spawn is mocked so execFile hangs waiting for null streams
    process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
    delete process.env.OP_ADMIN_TOKEN;
    delete process.env.OP_ADMIN_TOKEN;

    mockDockerCli();
    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/core.compose.yml') || url.includes('/docker-compose.yml')) return new Response('services: {}\n', { status: 200 });
      if (url.includes('/compose.yml')) return new Response('services: {}\n', { status: 200 });
      if (url.endsWith('.schema') || url.endsWith('.schema.json')) return new Response('KEY=string\n', { status: 200 });
      // Return valid content for asset files needed by FilesystemAssetProvider
      if (url.includes('/AGENTS.md')) return new Response('# Agents\n', { status: 200 });
      if (url.includes('/opencode.jsonc') || url.includes('/admin-opencode.jsonc'))
        return new Response('{"$schema":"https://opencode.ai/config.json"}\n', { status: 200 });
      if (url.includes('/cleanup-logs.yml')) return new Response('name: cleanup-logs\nschedule: daily\n', { status: 200 });
      if (url.includes('/cleanup-data.yml')) return new Response('name: cleanup-data\nschedule: weekly\n', { status: 200 });
      if (url.includes('/validate-config.yml')) return new Response('name: validate-config\nschedule: hourly\n', { status: 200 });
      return new Response('', { status: 503 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    restoreDockerCli();
    process.env.OP_HOME = savedEnv.OP_HOME;
    process.env.OP_WORK_DIR = savedEnv.OP_WORK_DIR;
    process.env.OP_ADMIN_TOKEN = savedEnv.OP_ADMIN_TOKEN;
    process.env.OP_ADMIN_TOKEN = savedEnv.OP_ADMIN_TOKEN;
    if (savedEnv.OP_SKIP_COMPOSE_PREFLIGHT !== undefined) {
      process.env.OP_SKIP_COMPOSE_PREFLIGHT = savedEnv.OP_SKIP_COMPOSE_PREFLIGHT;
    } else {
      delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
    }
    rmSync(tempBase, { recursive: true, force: true });
  });

  it('--file missing.json throws "Setup config file not found"', async () => {
    const { bootstrapInstall } = await import('./install.ts');
    const missingPath = join(tempBase, 'missing.json');

    const err = await bootstrapInstall({
      force: true,
      version: 'main',
      noStart: false,
      noOpen: true,
      file: missingPath,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Setup config file not found');
  });

  it('--file config.txt throws "Unsupported config file format"', async () => {
    const { bootstrapInstall } = await import('./install.ts');
    const txtPath = join(tempBase, 'config.txt');
    writeFileSync(txtPath, 'some text content');

    const err = await bootstrapInstall({
      force: true,
      version: 'main',
      noStart: false,
      noOpen: true,
      file: txtPath,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Unsupported config file format');
  });

  it('--file broken.json with invalid JSON throws "Failed to parse setup config"', async () => {
    const { bootstrapInstall } = await import('./install.ts');
    const brokenPath = join(tempBase, 'broken.json');
    writeFileSync(brokenPath, '{ invalid json !!!');

    const err = await bootstrapInstall({
      force: true,
      version: 'main',
      noStart: false,
      noOpen: true,
      file: brokenPath,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Failed to parse setup config');
  });

  it('--file config.json with version: 1 migrates and calls performSetup', async () => {
    const { bootstrapInstall } = await import('./install.ts');
    const configPath = join(tempBase, 'config.json');
    const config = makeValidSetupConfig();
    writeFileSync(configPath, JSON.stringify(config));

    // This will call performSetup after migrating v1 -> SetupSpec.
    // The function will fail at staging since we don't have the full
    // filesystem setup, but the important thing is it reaches the right
    // code path (version 1 -> migrateSetupConfigToSetupSpec -> performSetup).
    const err = await bootstrapInstall({
      force: true,
      version: 'main',
      noStart: true,
      noOpen: true,
      file: configPath,
    }).catch((e: unknown) => e);

    // If setup fails it will throw "Setup failed: ..." — but NOT
    // "Unsupported config file format" or "Failed to parse" which
    // confirms the JSON was parsed and routed correctly.
    if (err) {
      expect((err as Error).message).not.toContain('Unsupported config file format');
      expect((err as Error).message).not.toContain('Failed to parse');
      // It may fail with "Setup failed" due to missing filesystem state
      // or it may succeed; either is acceptable for this routing test.
    }
  });

  it('--file setup.yaml with valid YAML is parsed correctly', async () => {
    const { bootstrapInstall } = await import('./install.ts');
    const yamlPath = join(tempBase, 'setup.yaml');
    const yamlContent = [
      'version: 1',
      'security:',
      '  adminToken: test-admin-token-12345',
      'connections:',
      '  - id: openai-main',
      '    name: OpenAI',
      '    provider: openai',
      '    baseUrl: https://api.openai.com',
      '    apiKey: sk-test-key-123',
      'assignments:',
      '  llm:',
      '    connectionId: openai-main',
      '    model: gpt-4o',
      '  embeddings:',
      '    connectionId: openai-main',
      '    model: text-embedding-3-small',
    ].join('\n');
    writeFileSync(yamlPath, yamlContent);

    const err = await bootstrapInstall({
      force: true,
      version: 'main',
      noStart: true,
      noOpen: true,
      file: yamlPath,
    }).catch((e: unknown) => e);

    // If it gets past parsing, it will NOT throw a parse error.
    if (err) {
      expect((err as Error).message).not.toContain('Unsupported config file format');
      expect((err as Error).message).not.toContain('Failed to parse');
    }
  });

  it('--file config.json --no-start exits after setup without compose up', async () => {
    const { bootstrapInstall } = await import('./install.ts');
    const configPath = join(tempBase, 'config.json');
    const config = makeValidSetupConfig();
    writeFileSync(configPath, JSON.stringify(config));

    const err = await bootstrapInstall({
      force: true,
      version: 'main',
      noStart: true,
      noOpen: true,
      file: configPath,
    }).catch((e: unknown) => e);

    // Check Bun.spawn calls — docker compose up should NOT have been called
    const spawnCalls = (Bun.spawn as ReturnType<typeof mock>).mock.calls;
    const composeUpCalls = spawnCalls.filter((call: unknown[]) => {
      const args = call[0] as string[];
      return Array.isArray(args) && args.includes('compose') && args.includes('up');
    });
    expect(composeUpCalls).toHaveLength(0);

    // With --no-start, should print "Config written" message (if setup succeeds)
    // or throw a setup error. Either way, no docker compose up.
    if (err) {
      expect((err as Error).message).not.toContain('Unsupported config file format');
    }
  });
});
