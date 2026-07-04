import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveTasksDir, listTaskFiles, readTaskFile, writeTaskFile, removeTaskFile, assertSafeTaskFilename,
} from './task-files.js';

let stashDir = '';

beforeEach(() => { stashDir = mkdtempSync(join(tmpdir(), 'op-tasks-')); });
afterEach(() => { rmSync(stashDir, { recursive: true, force: true }); });

describe('task-files', () => {
  it('lists only .yml/.yaml/.md files with sizes', () => {
    const dir = resolveTasksDir(stashDir);
    writeFileSync(join(dir, 'health-check.yml'), 'enabled: false\n');
    writeFileSync(join(dir, 'notes.md'), '# notes\n');
    writeFileSync(join(dir, 'ignore.txt'), 'x');
    const files = listTaskFiles(stashDir);
    const names = files.map((f) => f.name);
    expect(names).toContain('health-check.yml');
    expect(names).toContain('notes.md');
    expect(names).not.toContain('ignore.txt');
    expect(files.find((f) => f.name === 'health-check.yml')?.size).toBe('enabled: false\n'.length);
  });

  it('reads, writes (0644), and removes a task file', () => {
    writeTaskFile(stashDir, 'my-task.yml', "schedule: '0 9 * * *'\nenabled: true\n");
    expect(statSync(join(resolveTasksDir(stashDir), 'my-task.yml')).mode & 0o777).toBe(0o644);
    expect(readTaskFile(stashDir, 'my-task.yml')).toContain('enabled: true');
    removeTaskFile(stashDir, 'my-task.yml');
    expect(readTaskFile(stashDir, 'my-task.yml')).toBeNull();
  });

  it('rejects traversal and non-task extensions', () => {
    expect(() => assertSafeTaskFilename('../escape.yml')).toThrow();
    expect(() => assertSafeTaskFilename('a/b.yml')).toThrow();
    expect(() => assertSafeTaskFilename('secrets.txt')).toThrow();
    expect(() => assertSafeTaskFilename('config.json')).toThrow();
    expect(() => assertSafeTaskFilename('ok.yml')).not.toThrow();
    expect(() => assertSafeTaskFilename('ok.yaml')).not.toThrow();
    expect(() => assertSafeTaskFilename('ok.md')).not.toThrow();
  });
});
