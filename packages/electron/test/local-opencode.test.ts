// Run via vitest (Node), NOT bun test — bun cannot honor vi.mock() hoisting for
// electron imports. Use: bun run --cwd packages/electron test

/**
 * Tests for the ephemeral local OpenCode spawn module.
 *
 * The opencode binary is NEVER invoked: we replace the spawner with a fake
 * child (EventEmitter) that emits a listening URL on stdout. Tests cover:
 *   - Pure helpers (path resolution, password generation shape, runtime JSON)
 *   - Pidfile read/write + sweep semantics
 *   - Lifecycle: spawn writes runtime + pidfile (0600), stop unlinks both
 *   - Failure mode: spawn throws → sentinel written, no crash
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import {
  _setSpawn,
  _resetSpawn,
  adminOpencodeHome,
  buildRuntimeJson,
  generatePassword,
  normalizeLoopbackUrl,
  isPidAlive,
  pidfilePath,
  readPidFile,
  runtimePath,
  stageAdminHome,
  startLocalOpenCode,
  sweepStalePid,
  unavailableSentinelPath,
  writePidFile,
  writeRuntimeFile,
} from '../src/local-opencode.js';

let dataDir: string;

/**
 * Build a fake ChildProcess. Defaults to a near-certainly-dead pid so stop()
 * skips real signalling. Emits the listening line (or an early exit) on the
 * next tick, after startLocalOpenCode has attached its stdout/exit listeners.
 */
function makeFakeChild(opts: { pid?: number; listenUrl?: string; exitCode?: number }): EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = opts.pid ?? 2_147_483_640;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    if (opts.exitCode !== undefined) child.emit('exit', opts.exitCode);
    else child.stdout.emit('data', Buffer.from(`opencode server listening on ${opts.listenUrl}\n`));
  }, 0);
  return child;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'openpalm-local-opencode-test-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  _resetSpawn();
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('path helpers', () => {
  it('runtime path lives directly under dataDir', () => {
    expect(runtimePath('/x')).toBe('/x/local-opencode.runtime.json');
  });
  it('pidfile lives directly under dataDir', () => {
    expect(pidfilePath('/x')).toBe('/x/local-opencode.pid');
  });
  it('unavailable sentinel lives directly under dataDir', () => {
    expect(unavailableSentinelPath('/x')).toBe('/x/local-opencode.unavailable');
  });
  it('admin OpenCode HOME is a child of dataDir', () => {
    expect(adminOpencodeHome('/x')).toBe('/x/admin-opencode-home');
  });
});

describe('normalizeLoopbackUrl', () => {
  it('rewrites a 0.0.0.0 bind address to loopback (browser cannot load 0.0.0.0)', () => {
    expect(normalizeLoopbackUrl('http://0.0.0.0:44145')).toBe('http://127.0.0.1:44145');
    expect(normalizeLoopbackUrl('http://0.0.0.0:44145/')).toBe('http://127.0.0.1:44145/');
  });
  it('rewrites the IPv6 any address [::] to loopback', () => {
    expect(normalizeLoopbackUrl('http://[::]:8080')).toBe('http://127.0.0.1:8080');
  });
  it('leaves already-loopback and other hosts untouched', () => {
    expect(normalizeLoopbackUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321');
    expect(normalizeLoopbackUrl('http://localhost:3800')).toBe('http://localhost:3800');
    expect(normalizeLoopbackUrl('https://example.com:9/x')).toBe('https://example.com:9/x');
  });
});

describe('generatePassword', () => {
  it('returns a base64url string with no padding', () => {
    const pw = generatePassword();
    // 32 random bytes → 43-char base64url (no padding).
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pw).toHaveLength(43);
  });

  it('produces unique values across calls', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
  });
});

describe('buildRuntimeJson', () => {
  it('packs the expected shape', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const r = buildRuntimeJson('http://127.0.0.1:12345', 'pw', 99, when);
    expect(r).toEqual({
      url: 'http://127.0.0.1:12345',
      username: 'openpalm',
      password: 'pw',
      pid: 99,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  it('returns false for impossible pids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    // Very large pid that almost certainly isn't allocated.
    expect(isPidAlive(2_147_483_640)).toBe(false);
  });
});

describe('stageAdminHome', () => {
  it('writes opencode.json with the supplied plugin path', () => {
    const pluginPath = '/opt/resources/admin-tools-plugin/index.js';
    const { home, configDir } = stageAdminHome(dataDir, pluginPath);
    expect(home).toBe(adminOpencodeHome(dataDir));
    const configPath = join(configDir, 'opencode.json');
    expect(existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.plugin).toEqual([pluginPath]);
  });

  it('is idempotent — does not overwrite an existing opencode.json', () => {
    const { configDir } = stageAdminHome(dataDir, '/some/path/index.js');
    const configPath = join(configDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({ plugin: ['user-customised'] }));
    stageAdminHome(dataDir, '/other/path/index.js');
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.plugin).toEqual(['user-customised']);
  });
});

describe('writeRuntimeFile + writePidFile', () => {
  it('writes runtime.json with 0600 permissions', () => {
    writeRuntimeFile(dataDir, buildRuntimeJson('http://x', 'pw', 1));
    const path = runtimePath(dataDir);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed.url).toBe('http://x');
  });

  it('writes pidfile with 0600 permissions and round-trips', () => {
    writePidFile(dataDir, 12345);
    const mode = statSync(pidfilePath(dataDir)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readPidFile(dataDir)).toBe(12345);
  });

  it('readPidFile returns null when pidfile is absent', () => {
    expect(readPidFile(dataDir)).toBeNull();
  });

  it('readPidFile returns null when pidfile contains garbage', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(pidfilePath(dataDir), 'not-a-pid');
    expect(readPidFile(dataDir)).toBeNull();
  });
});

describe('sweepStalePid', () => {
  it('unlinks pidfile + runtime.json when nothing is there', () => {
    const r = sweepStalePid(dataDir);
    expect(r.swept).toBe(false);
    expect(r.pid).toBeNull();
  });

  it('returns swept=false when the pid is dead and unlinks the file', () => {
    writePidFile(dataDir, 2_147_483_640); // almost certainly dead
    writeRuntimeFile(dataDir, buildRuntimeJson('http://x', 'pw', 2_147_483_640));
    const r = sweepStalePid(dataDir);
    expect(r.swept).toBe(false);
    expect(r.pid).toBe(2_147_483_640);
    expect(existsSync(pidfilePath(dataDir))).toBe(false);
    expect(existsSync(runtimePath(dataDir))).toBe(false);
  });
});

// ── Lifecycle (SDK stubbed) ──────────────────────────────────────────────────

describe('startLocalOpenCode (SDK stubbed)', () => {
  it('spawns, writes runtime.json + pidfile, and stop() cleans them up', async () => {
    const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;
    const originalUsername = process.env.OPENCODE_SERVER_USERNAME;
    _setSpawn(() => makeFakeChild({ listenUrl: 'http://127.0.0.1:54321' }) as never);

    const handle = await startLocalOpenCode({ dataDir, pluginPath: '/test/admin-tools-plugin/index.js' });
    expect(handle).not.toBeNull();
    expect(handle!.url).toBe('http://127.0.0.1:54321');
    expect(handle!.username).toBe('openpalm');
    expect(handle!.password).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Runtime + pidfile written.
    expect(existsSync(runtimePath(dataDir))).toBe(true);
    expect(existsSync(pidfilePath(dataDir))).toBe(true);
    expect(existsSync(unavailableSentinelPath(dataDir))).toBe(false);

    // Files are 0600.
    expect(statSync(runtimePath(dataDir)).mode & 0o777).toBe(0o600);
    expect(statSync(pidfilePath(dataDir)).mode & 0o777).toBe(0o600);

    // Runtime.json carries the URL + password we generated.
    const rt = JSON.parse(readFileSync(runtimePath(dataDir), 'utf-8'));
    expect(rt.url).toBe('http://127.0.0.1:54321');
    expect(rt.password).toBe(handle!.password);

    // Process env is restored after spawn — the password should not leak
    // into the rest of the Electron main.
    expect(process.env.OPENCODE_SERVER_PASSWORD).toBe(originalPassword);
    expect(process.env.OPENCODE_SERVER_USERNAME).toBe(originalUsername);

    await handle!.stop();
    expect(existsSync(runtimePath(dataDir))).toBe(false);
    expect(existsSync(pidfilePath(dataDir))).toBe(false);
  }, 10_000);

  it('writes the unavailable sentinel and returns null when spawn throws', async () => {
    const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;
    _setSpawn(() => { throw new Error('spawn opencode ENOENT: no such file or directory'); });

    const handle = await startLocalOpenCode({ dataDir, pluginPath: '/test/admin-tools-plugin/index.js' });
    expect(handle).toBeNull();
    expect(existsSync(unavailableSentinelPath(dataDir))).toBe(true);
    const sentinel = JSON.parse(readFileSync(unavailableSentinelPath(dataDir), 'utf-8'));
    expect(sentinel.reason).toMatch(/opencode binary|spawn/i);
    // No runtime.json / pidfile on failure.
    expect(existsSync(runtimePath(dataDir))).toBe(false);
    expect(existsSync(pidfilePath(dataDir))).toBe(false);

    // Env is restored even after failure.
    expect(process.env.OPENCODE_SERVER_PASSWORD).toBe(originalPassword);
  });

  it('sweeps stale state from a previous run before spawning', async () => {
    // Pre-populate stale state from a crashed prior launch.
    writePidFile(dataDir, 2_147_483_640);
    writeRuntimeFile(dataDir, buildRuntimeJson('http://stale', 'stale-pw', 1));
    writeFileSync(unavailableSentinelPath(dataDir), '{"reason":"old"}', { mode: 0o600 });

    _setSpawn(() => makeFakeChild({ listenUrl: 'http://127.0.0.1:9999' }) as never);

    const handle = await startLocalOpenCode({ dataDir, pluginPath: '/test/admin-tools-plugin/index.js' });
    expect(handle).not.toBeNull();
    const rt = JSON.parse(readFileSync(runtimePath(dataDir), 'utf-8'));
    expect(rt.url).toBe('http://127.0.0.1:9999');
    expect(rt.password).not.toBe('stale-pw');
    expect(existsSync(unavailableSentinelPath(dataDir))).toBe(false);

    await handle!.stop();
  }, 10_000);
});
