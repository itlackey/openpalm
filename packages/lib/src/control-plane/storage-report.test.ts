import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildStorageReport,
  CACHE_RELATIVE_PATHS,
  cleanCaches,
  formatStorageReport,
  OPENCODE_STORE_RELATIVE_PATHS,
  pathSizeBytes,
  TOOL_TREE_RELATIVE_PATHS,
} from './storage-report.js';
import type { DockerClient, DockerResult } from './docker.js';

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-storage-report-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('cache-path safelist (S1) never touches secrets/knowledge/sessions/DB', () => {
  it('contains no path under knowledge/, secrets, or an OpenCode DB/session file', () => {
    for (const p of CACHE_RELATIVE_PATHS) {
      expect(p).not.toMatch(/secrets|knowledge|\.db\b|-wal\b|-shm\b|session|auth\.json|backups/i);
    }
  });

  it('is disjoint from the reported (but never purged) tool-tree and OpenCode-store paths', () => {
    const cacheSet = new Set<string>(CACHE_RELATIVE_PATHS);
    for (const p of TOOL_TREE_RELATIVE_PATHS) expect(cacheSet.has(p)).toBe(false);
    for (const p of OPENCODE_STORE_RELATIVE_PATHS) expect(cacheSet.has(p)).toBe(false);
  });
});

describe('pathSizeBytes', () => {
  it('returns 0 for a path that does not exist', () => {
    expect(pathSizeBytes(join(homeDir, 'nope'))).toBe(0);
  });

  it('returns a single file\'s size', () => {
    const file = join(homeDir, 'a.txt');
    writeFileSync(file, 'x'.repeat(1234));
    expect(pathSizeBytes(file)).toBe(1234);
  });

  it('recursively sums every file under a directory tree', () => {
    mkdirSync(join(homeDir, 'a', 'b'), { recursive: true });
    writeFileSync(join(homeDir, 'a', 'one.txt'), 'x'.repeat(100));
    writeFileSync(join(homeDir, 'a', 'b', 'two.txt'), 'y'.repeat(250));
    expect(pathSizeBytes(join(homeDir, 'a'))).toBe(350);
  });
});

describe('cleanCaches (S1/S8 — regenerable caches only)', () => {
  it('refuses to run without confirm: true', () => {
    expect(() => cleanCaches(homeDir, { confirm: false })).toThrow(/confirm/i);
  });

  it('removes only the safelisted cache directories and recreates them empty', () => {
    const cacheDir = join(homeDir, 'data', 'assistant', '.cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'blob.bin'), 'z'.repeat(5000));

    // A sibling durable file that must survive untouched.
    const secretsDir = join(homeDir, 'knowledge', 'secrets');
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, 'op_ui_login_password'), 'super-secret');

    const dbFile = join(homeDir, 'data', 'assistant', '.local', 'share', 'opencode', 'opencode.db');
    mkdirSync(join(homeDir, 'data', 'assistant', '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(dbFile, 'not-a-real-db'.repeat(50));

    const result = cleanCaches(homeDir, { confirm: true });

    expect(result.removed).toContain('data/assistant/.cache');
    expect(result.freedBytes).toBeGreaterThanOrEqual(5000);
    // Cache dir is recreated empty, not left missing (entrypoints expect it to exist).
    expect(existsSync(cacheDir)).toBe(true);
    expect(pathSizeBytes(cacheDir)).toBe(0);

    // Secrets and the OpenCode DB are untouched.
    expect(readFileSync(join(secretsDir, 'op_ui_login_password'), 'utf-8')).toBe('super-secret');
    expect(existsSync(dbFile)).toBe(true);
  });

  it('is a no-op dry run that reports the same freed bytes without deleting anything', () => {
    const cacheDir = join(homeDir, 'data', 'assistant', '.cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'blob.bin'), 'z'.repeat(1000));

    const result = cleanCaches(homeDir, { confirm: true, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.freedBytes).toBeGreaterThanOrEqual(1000);
    expect(existsSync(join(cacheDir, 'blob.bin'))).toBe(true);
  });

  it('is silently a no-op when no cache directories exist yet', () => {
    const result = cleanCaches(homeDir, { confirm: true });
    expect(result.removed).toEqual([]);
    expect(result.freedBytes).toBe(0);
  });
});

describe('buildStorageReport', () => {
  it('composes filesystem/cache/tool-tree/OpenCode-store/backups sizes plus the docker report', async () => {
    mkdirSync(join(homeDir, 'data', 'assistant', '.cache'), { recursive: true });
    writeFileSync(join(homeDir, 'data', 'assistant', '.cache', 'x'), 'a'.repeat(100));
    mkdirSync(join(homeDir, 'data', 'assistant', 'tools'), { recursive: true });
    writeFileSync(join(homeDir, 'data', 'assistant', 'tools', 'pkg.bin'), 'b'.repeat(200));
    mkdirSync(join(homeDir, 'data', 'backups', 'snap-1'), { recursive: true });
    writeFileSync(join(homeDir, 'data', 'backups', 'snap-1', 'stack.env'), 'c'.repeat(50));

    const client: DockerClient = {
      run: async (args: string[]): Promise<DockerResult> => {
        if (args[0] === 'images') return { ok: true, stdout: '', stderr: '', code: 0 };
        if (args[0] === 'volume') return { ok: true, stdout: '', stderr: '', code: 0 };
        throw new Error(`unexpected: ${args.join(' ')}`);
      },
    };

    const report = await buildStorageReport({ homeDir, dockerClient: client });

    expect(report.totalCacheBytes).toBe(100);
    expect(report.totalToolTreeBytes).toBe(200);
    expect(report.backups.bytes).toBe(50);
    expect(report.docker.reliable).toBe(true);
    expect(report.filesystem.path).toBe(homeDir);
  });

  it('skips the docker query and marks it unreliable when skipDocker is set', async () => {
    const report = await buildStorageReport({ homeDir, skipDocker: true });
    expect(report.docker.reliable).toBe(false);
  });

  it('formatStorageReport renders a non-empty human-readable summary', async () => {
    const report = await buildStorageReport({ homeDir, skipDocker: true });
    const text = formatStorageReport(report);
    expect(text).toContain('Storage report:');
    expect(text.length).toBeGreaterThan(0);
  });
});
