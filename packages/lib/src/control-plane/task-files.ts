/**
 * Local task access retained for the exact daily-briefing home migration and
 * legacy read exports. Production CRUD runs through automation-runtime.ts.
 *
 * Publication uses optimistic identity/content checks. A same-user process can
 * still change a pathname in the final check-to-rename window; Node exposes no
 * portable conditional rename primitive, and this one-time migration does not
 * justify a displaced-file recovery protocol.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { syncDirectory } from './fs-atomic.js';
import type { TaskFileSnapshot } from './task-file-contract.js';
import {
  assertPortableTaskFilename,
  assertTaskRevision,
  portableTaskFilenameError,
  TASK_CONTENT_MAX_BYTES,
  TASK_FILE_MAX_VISIBLE,
  taskIdFromTaskFilename as taskIdFromPortableFilename,
} from './task-file-contract.js';

export type TaskFileInfo = { name: string; size: number; revision: string };
export type { TaskFileSnapshot };

export class TaskFileConflictError extends Error {
  constructor(name: string) {
    super(`Task file changed since it was loaded: ${name}`);
    this.name = 'TaskFileConflictError';
  }
}

type DirectoryEntry = { path: string; realPath: string; stats: Stats };
type TaskDirectory = DirectoryEntry & { ancestors: DirectoryEntry[] };
type InternalTaskSnapshot = TaskFileSnapshot & { bytes: Buffer; stats: Stats };

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function optionalOpenFlag(name: 'O_NOFOLLOW' | 'O_NONBLOCK'): number {
  return fs.constants[name] ?? 0;
}

function lstatIfExists(path: string): Stats | null {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  return (
    left.birthtimeMs === right.birthtimeMs && (left.mode & 0o170000) === (right.mode & 0o170000)
  );
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readDirectory(path: string, label: string): DirectoryEntry {
  const stats = fs.lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return { path, realPath: fs.realpathSync.native(path), stats };
}

function optionalDirectory(path: string, label: string): DirectoryEntry | null {
  const stats = lstatIfExists(path);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return { path, realPath: fs.realpathSync.native(path), stats };
}

function assertDirectoryEntryCurrent(entry: DirectoryEntry): void {
  const current = lstatIfExists(entry.path);
  if (
    current === null ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameIdentity(entry.stats, current) ||
    fs.realpathSync.native(entry.path) !== entry.realPath
  ) {
    throw new Error(`Task directory changed during migration: ${entry.path}`);
  }
}

function assertTaskDirectoryCurrent(directory: TaskDirectory): void {
  for (const ancestor of directory.ancestors) assertDirectoryEntryCurrent(ancestor);
  assertDirectoryEntryCurrent(directory);
}

function openExistingHomeTaskDirectory(homeDir: string): TaskDirectory | null {
  const home = readDirectory(homeDir, 'OP_HOME');
  const knowledge = optionalDirectory(join(homeDir, 'knowledge'), 'Knowledge directory');
  if (knowledge === null) return null;
  const tasks = optionalDirectory(join(knowledge.path, 'tasks'), 'Task directory');
  if (tasks === null) return null;
  return { ...tasks, ancestors: [home, knowledge] };
}

function openLegacyTaskDirectory(stashDir: string): TaskDirectory {
  const stash = readDirectory(stashDir, 'Knowledge directory');
  const path = join(stashDir, 'tasks');
  if (lstatIfExists(path) === null) fs.mkdirSync(path);
  return { ...readDirectory(path, 'Task directory'), ancestors: [stash] };
}

function assertRegularTask(stats: Stats, name: string): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error(`Task file must be a regular file without symbolic or hard links: ${name}`);
  }
  if (stats.size > TASK_CONTENT_MAX_BYTES) {
    throw new Error(`Task file exceeds ${TASK_CONTENT_MAX_BYTES} bytes: ${name}`);
  }
}

function openTask(path: string, flags: number, mode?: number): number {
  return fs.openSync(
    path,
    flags | optionalOpenFlag('O_NOFOLLOW') | optionalOpenFlag('O_NONBLOCK'),
    mode,
  );
}

function readBounded(descriptor: number, name: string): Buffer {
  const bytes = Buffer.allocUnsafe(TASK_CONTENT_MAX_BYTES + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = fs.readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset > TASK_CONTENT_MAX_BYTES) {
    throw new Error(`Task file exceeds ${TASK_CONTENT_MAX_BYTES} bytes: ${name}`);
  }
  return bytes.subarray(0, offset);
}

function revision(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function contentBytes(content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.toString('utf8') !== content) throw new Error('Task content must be valid UTF-8 text');
  if (bytes.byteLength > TASK_CONTENT_MAX_BYTES) {
    throw new Error(`Task content exceeds ${TASK_CONTENT_MAX_BYTES} bytes`);
  }
  return bytes;
}

function readTask(directory: TaskDirectory, name: string): InternalTaskSnapshot | null {
  assertTaskDirectoryCurrent(directory);
  const path = join(directory.path, name);
  const before = lstatIfExists(path);
  if (before === null) return null;
  assertRegularTask(before, name);

  let descriptor: number;
  try {
    descriptor = openTask(path, fs.constants.O_RDONLY);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    if (errorCode(error) === 'ELOOP') {
      throw new Error(`Task file must be a regular file without symbolic or hard links: ${name}`);
    }
    throw error;
  }

  try {
    const opened = fs.fstatSync(descriptor);
    assertRegularTask(opened, name);
    if (!sameSnapshot(before, opened)) throw new TaskFileConflictError(name);
    const bytes = readBounded(descriptor, name);
    const descriptorAfter = fs.fstatSync(descriptor);
    const after = lstatIfExists(path);
    assertRegularTask(descriptorAfter, name);
    if (after !== null) assertRegularTask(after, name);
    if (
      after === null ||
      !sameSnapshot(opened, descriptorAfter) ||
      !sameSnapshot(descriptorAfter, after)
    ) {
      throw new TaskFileConflictError(name);
    }
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error(`Task file must contain valid UTF-8 text: ${name}`);
    }
    assertTaskDirectoryCurrent(directory);
    return { bytes, content, revision: revision(bytes), stats: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

function replaceTask(
  directory: TaskDirectory,
  name: string,
  replacement: Buffer,
  expected: InternalTaskSnapshot,
): string {
  const temporaryName = `.openpalm-task-${process.pid}-${randomUUID()}.tmp`;
  const temporaryPath = join(directory.path, temporaryName);
  const targetPath = join(directory.path, name);
  const descriptor = openTask(
    temporaryPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    expected.stats.mode & 0o777,
  );
  const temporaryStats = fs.fstatSync(descriptor);
  assertRegularTask(temporaryStats, name);
  let closed = false;
  let published = false;

  try {
    fs.fchmodSync(descriptor, expected.stats.mode & 0o777);
    fs.writeFileSync(descriptor, replacement);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    closed = true;
    assertTaskDirectoryCurrent(directory);

    const current = readTask(directory, name);
    if (
      current === null ||
      !sameSnapshot(expected.stats, current.stats) ||
      !expected.bytes.equals(current.bytes)
    ) {
      throw new TaskFileConflictError(name);
    }
    const staged = readTask(directory, temporaryName);
    if (
      staged === null ||
      !sameIdentity(temporaryStats, staged.stats) ||
      !staged.bytes.equals(replacement)
    ) {
      throw new TaskFileConflictError(name);
    }

    assertTaskDirectoryCurrent(directory);
    fs.renameSync(temporaryPath, targetPath);
    published = true;

    syncDirectory(directory.path);
    assertTaskDirectoryCurrent(directory);
    const installed = readTask(directory, name);
    if (
      installed === null ||
      !sameIdentity(temporaryStats, installed.stats) ||
      !installed.bytes.equals(replacement)
    ) {
      throw new TaskFileConflictError(name);
    }
    return installed.revision;
  } finally {
    if (!closed) fs.closeSync(descriptor);
    if (!published) {
      try {
        const current = fs.lstatSync(temporaryPath);
        if (sameIdentity(temporaryStats, current)) fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original failure; this path names only our unique temp.
      }
    }
  }
}

export function resolveTasksDir(stashDir: string): string {
  return openLegacyTaskDirectory(stashDir).path;
}

export function assertSafeTaskFilename(name: string): void {
  assertPortableTaskFilename(name);
}

export function taskIdFromTaskFilename(name: string): string {
  return taskIdFromPortableFilename(name);
}

export function listTaskFiles(stashDir: string): TaskFileInfo[] {
  const directory = openLegacyTaskDirectory(stashDir);
  const files: TaskFileInfo[] = [];
  for (const entry of fs.readdirSync(directory.path, { withFileTypes: true })) {
    if (files.length >= TASK_FILE_MAX_VISIBLE) break;
    if (!entry.isFile() || portableTaskFilenameError(entry.name) !== null) continue;
    try {
      const snapshot = readTask(directory, entry.name);
      if (snapshot !== null) {
        files.push({
          name: entry.name,
          size: snapshot.bytes.byteLength,
          revision: snapshot.revision,
        });
      }
    } catch {
      // Legacy listing omits malformed or unsafe entries.
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

export function readTaskFileSnapshot(stashDir: string, name: string): TaskFileSnapshot | null {
  assertPortableTaskFilename(name);
  const snapshot = readTask(openLegacyTaskDirectory(stashDir), name);
  return snapshot === null ? null : { content: snapshot.content, revision: snapshot.revision };
}

export function readTaskFile(stashDir: string, name: string): string | null {
  return readTaskFileSnapshot(stashDir, name)?.content ?? null;
}

export function writeTaskFile(
  stashDir: string,
  name: string,
  content: string,
  expectedRevision: string,
): string {
  assertPortableTaskFilename(name);
  assertTaskRevision(expectedRevision);
  const directory = openLegacyTaskDirectory(stashDir);
  const expected = readTask(directory, name);
  if (expected === null || expected.revision !== expectedRevision)
    throw new TaskFileConflictError(name);
  const replacement = contentBytes(content);
  if (replacement.equals(expected.bytes)) return expected.revision;
  return replaceTask(directory, name, replacement, expected);
}

/** Replace only an exact historical task; absent, current, and modified files are untouched. */
export function replaceTaskFileForHomeMigration(
  homeDir: string,
  name: string,
  historicalContents: ReadonlySet<string>,
  replacement: string,
): boolean {
  assertPortableTaskFilename(name);
  const replacementBytes = contentBytes(replacement);
  const directory = openExistingHomeTaskDirectory(homeDir);
  if (directory === null) return false;

  let snapshot: InternalTaskSnapshot | null;
  try {
    snapshot = readTask(directory, name);
  } catch (error) {
    if (error instanceof TaskFileConflictError) throw error;
    // This optional migration must never make an unusual user-owned task file
    // (symlink, hard link, oversized, or non-UTF-8) block every future launch.
    return false;
  }
  if (snapshot === null) return false;
  if (snapshot.bytes.equals(replacementBytes)) {
    syncDirectory(directory.path);
    return false;
  }
  if (!historicalContents.has(snapshot.content)) return false;
  replaceTask(directory, name, replacementBytes, snapshot);
  return true;
}
