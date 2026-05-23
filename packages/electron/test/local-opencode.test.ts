/**
 * Tests for the ephemeral local OpenCode spawn module.
 *
 * The opencode binary is NEVER invoked: we replace the SDK loader with a
 * stub that resolves a fake server handle. Tests cover:
 *   - Pure helpers (path resolution, password generation shape, runtime JSON)
 *   - Pidfile read/write + sweep semantics
 *   - Lifecycle: spawn writes runtime + pidfile (0600), stop unlinks both
 *   - Failure mode: SDK throws → sentinel written, no crash
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _setSdkLoader,
  adminOpencodeHome,
  buildRuntimeJson,
  generatePassword,
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

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'openpalm-local-opencode-test-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  // Reset the SDK loader back to the real one.
  _setSdkLoader(async () => await import('@opencode-ai/sdk').catch(() => ({
    createOpencodeServer: async () => { throw new Error('opencode not available'); },
  } as unknown as { createOpencodeServer: () => Promise<never> })));
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('path helpers', () => {
  it('runtime path lives directly under stateDir', () => {
    expect(runtimePath('/x')).toBe('/x/local-opencode.runtime.json');
  });
  it('pidfile lives directly under stateDir', () => {
    expect(pidfilePath('/x')).toBe('/x/local-opencode.pid');
  });
  it('unavailable sentinel lives directly under stateDir', () => {
    expect(unavailableSentinelPath('/x')).toBe('/x/local-opencode.unavailable');
  });
  it('admin OpenCode HOME is a child of stateDir', () => {
    expect(adminOpencodeHome('/x')).toBe('/x/admin-opencode-home');
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
  it('creates the HOME tree and writes opencode.json declaring the admin-tools plugin', () => {
    const { home, configDir } = stageAdminHome(stateDir);
    expect(home).toBe(adminOpencodeHome(stateDir));
    const configPath = join(configDir, 'opencode.json');
    expect(existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.plugin).toEqual(['@openpalm/admin-tools-plugin']);
  });

  it('is idempotent — does not overwrite an existing opencode.json', () => {
    const { configDir } = stageAdminHome(stateDir);
    const configPath = join(configDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({ plugin: ['user-customised'] }));
    stageAdminHome(stateDir);
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(cfg.plugin).toEqual(['user-customised']);
  });
});

describe('writeRuntimeFile + writePidFile', () => {
  it('writes runtime.json with 0600 permissions', () => {
    writeRuntimeFile(stateDir, buildRuntimeJson('http://x', 'pw', 1));
    const path = runtimePath(stateDir);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed.url).toBe('http://x');
  });

  it('writes pidfile with 0600 permissions and round-trips', () => {
    writePidFile(stateDir, 12345);
    const mode = statSync(pidfilePath(stateDir)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readPidFile(stateDir)).toBe(12345);
  });

  it('readPidFile returns null when pidfile is absent', () => {
    expect(readPidFile(stateDir)).toBeNull();
  });

  it('readPidFile returns null when pidfile contains garbage', () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(pidfilePath(stateDir), 'not-a-pid');
    expect(readPidFile(stateDir)).toBeNull();
  });
});

describe('sweepStalePid', () => {
  it('unlinks pidfile + runtime.json when nothing is there', () => {
    const r = sweepStalePid(stateDir);
    expect(r.swept).toBe(false);
    expect(r.pid).toBeNull();
  });

  it('returns swept=false when the pid is dead and unlinks the file', () => {
    writePidFile(stateDir, 2_147_483_640); // almost certainly dead
    writeRuntimeFile(stateDir, buildRuntimeJson('http://x', 'pw', 2_147_483_640));
    const r = sweepStalePid(stateDir);
    expect(r.swept).toBe(false);
    expect(r.pid).toBe(2_147_483_640);
    expect(existsSync(pidfilePath(stateDir))).toBe(false);
    expect(existsSync(runtimePath(stateDir))).toBe(false);
  });
});

// ── Lifecycle (SDK stubbed) ──────────────────────────────────────────────────

describe('startLocalOpenCode (SDK stubbed)', () => {
  it('spawns, writes runtime.json + pidfile, and stop() cleans them up', async () => {
    const close = vi.fn();
    _setSdkLoader(async () => ({
      createOpencodeServer: async () => ({
        url: 'http://127.0.0.1:54321',
        close,
      }),
    }));

    const handle = await startLocalOpenCode({ stateDir });
    expect(handle).not.toBeNull();
    expect(handle!.url).toBe('http://127.0.0.1:54321');
    expect(handle!.username).toBe('openpalm');
    expect(handle!.password).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Runtime + pidfile written.
    expect(existsSync(runtimePath(stateDir))).toBe(true);
    expect(existsSync(pidfilePath(stateDir))).toBe(true);
    expect(existsSync(unavailableSentinelPath(stateDir))).toBe(false);

    // Files are 0600.
    expect(statSync(runtimePath(stateDir)).mode & 0o777).toBe(0o600);
    expect(statSync(pidfilePath(stateDir)).mode & 0o777).toBe(0o600);

    // Runtime.json carries the URL + password we generated.
    const rt = JSON.parse(readFileSync(runtimePath(stateDir), 'utf-8'));
    expect(rt.url).toBe('http://127.0.0.1:54321');
    expect(rt.password).toBe(handle!.password);

    // Process env is restored after spawn — the password should not leak
    // into the rest of the Electron main.
    expect(process.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(process.env.OPENCODE_SERVER_USERNAME).toBeUndefined();

    await handle!.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(existsSync(runtimePath(stateDir))).toBe(false);
    expect(existsSync(pidfilePath(stateDir))).toBe(false);
  }, 10_000);

  it('writes the unavailable sentinel and returns null when the SDK throws', async () => {
    _setSdkLoader(async () => ({
      createOpencodeServer: async () => {
        throw new Error('spawn opencode ENOENT: no such file or directory');
      },
    }));

    const handle = await startLocalOpenCode({ stateDir });
    expect(handle).toBeNull();
    expect(existsSync(unavailableSentinelPath(stateDir))).toBe(true);
    const sentinel = JSON.parse(readFileSync(unavailableSentinelPath(stateDir), 'utf-8'));
    expect(sentinel.reason).toMatch(/opencode binary|spawn/i);
    // No runtime.json / pidfile on failure.
    expect(existsSync(runtimePath(stateDir))).toBe(false);
    expect(existsSync(pidfilePath(stateDir))).toBe(false);

    // Env is restored even after failure.
    expect(process.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
  });

  it('sweeps stale state from a previous run before spawning', async () => {
    // Pre-populate stale state from a crashed prior launch.
    writePidFile(stateDir, 2_147_483_640);
    writeRuntimeFile(stateDir, buildRuntimeJson('http://stale', 'stale-pw', 1));
    writeFileSync(unavailableSentinelPath(stateDir), '{"reason":"old"}', { mode: 0o600 });

    _setSdkLoader(async () => ({
      createOpencodeServer: async () => ({
        url: 'http://127.0.0.1:9999',
        close: () => {},
      }),
    }));

    const handle = await startLocalOpenCode({ stateDir });
    expect(handle).not.toBeNull();
    const rt = JSON.parse(readFileSync(runtimePath(stateDir), 'utf-8'));
    expect(rt.url).toBe('http://127.0.0.1:9999');
    expect(rt.password).not.toBe('stale-pw');
    expect(existsSync(unavailableSentinelPath(stateDir))).toBe(false);

    await handle!.stop();
  }, 10_000);
});
