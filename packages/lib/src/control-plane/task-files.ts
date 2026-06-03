/**
 * Raw file access for the Automations admin tab — a plain editor for the akm
 * task files in the assistant tasks dir (/stash/tasks = knowledge/tasks).
 *
 * akm task files are YAML (`.yml`/`.yaml`) or markdown (`.md`). Names are always
 * basenames within the tasks dir; the guard rejects path separators and `..`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TASK_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(ya?ml|md)$/;

export function assertSafeTaskFilename(name: string): void {
  if (!TASK_FILENAME_RE.test(name) || name.includes('..')) {
    throw new Error(`Invalid task file name: ${name} (expected a .yml/.yaml/.md basename)`);
  }
}

/** The assistant tasks dir for a given stash dir (knowledge). Created if absent. */
export function resolveTasksDir(stashDir: string): string {
  const dir = join(stashDir, 'tasks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type TaskFileInfo = { name: string; size: number };

/** List the task files (.yml/.yaml/.md) in the tasks dir, with byte sizes. */
export function listTaskFiles(stashDir: string): TaskFileInfo[] {
  const dir = resolveTasksDir(stashDir);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && TASK_FILENAME_RE.test(e.name) && !e.name.includes('..'))
    .map((e) => ({ name: e.name, size: statSync(join(dir, e.name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readTaskFile(stashDir: string, name: string): string | null {
  assertSafeTaskFilename(name);
  const path = join(resolveTasksDir(stashDir), name);
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

export function writeTaskFile(stashDir: string, name: string, content: string): void {
  assertSafeTaskFilename(name);
  writeFileSync(join(resolveTasksDir(stashDir), name), content, { mode: 0o644 });
}

export function removeTaskFile(stashDir: string, name: string): void {
  assertSafeTaskFilename(name);
  rmSync(join(resolveTasksDir(stashDir), name), { force: true });
}
