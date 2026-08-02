/**
 * Raw file access for the Automations admin tab — a plain editor for the akm
 * task files in the assistant tasks dir (/stash/tasks = knowledge/tasks).
 *
 * AKM v2 task files use the canonical `.yml` suffix. Names are always basenames
 * within the tasks dir; the guard rejects path separators and `..`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const TASK_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.yml$/;
const AMBIGUOUS_TASK_ID_SUFFIX_RE = /\.ya?ml$/i;

function isCanonicalTaskFilename(name: string): boolean {
  if (!TASK_FILENAME_RE.test(name)) return false;
  return !AMBIGUOUS_TASK_ID_SUFFIX_RE.test(name.slice(0, -4));
}

export function assertSafeTaskFilename(name: string): void {
  if (!isCanonicalTaskFilename(name) || name.includes('..')) {
    throw new Error(`Invalid task file name: ${name} (expected a .yml basename)`);
  }
}

/** Validate only the YAML transport shape; AKM owns all task semantics. */
export function assertTaskYamlDocument(content: string): void {
  let value: unknown;
  try {
    value = parseYaml(content);
  } catch (error) {
    throw new Error(`Invalid task YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid task YAML: expected an object');
  }
}

/** The assistant tasks dir for a given stash dir (knowledge). Created if absent. */
export function resolveTasksDir(stashDir: string): string {
  const dir = join(stashDir, 'tasks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type TaskFileInfo = { name: string; size: number };

/** List canonical `.yml` task files in the tasks dir, with byte sizes. */
export function listTaskFiles(stashDir: string): TaskFileInfo[] {
  const dir = resolveTasksDir(stashDir);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && isCanonicalTaskFilename(e.name) && !e.name.includes('..'))
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
  assertTaskYamlDocument(content);
  writeFileSync(join(resolveTasksDir(stashDir), name), content, { mode: 0o644 });
}

export function removeTaskFile(stashDir: string, name: string): void {
  assertSafeTaskFilename(name);
  rmSync(join(resolveTasksDir(stashDir), name), { force: true });
}
