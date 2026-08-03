import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set([
  'EACCES',
  'EBADF',
  'EINVAL',
  'EISDIR',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
]);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function optionalOpenFlag(name: 'O_DIRECTORY' | 'O_NOFOLLOW'): number {
  return fs.constants[name] ?? 0;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  return (
    left.birthtimeMs === right.birthtimeMs && (left.mode & 0o170000) === (right.mode & 0o170000)
  );
}

function lstatIfExists(path: string): Stats | null {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

// macOS exposes standard roots such as /var through a top-level symlink. Resolve
// that host-owned mount prefix, then reject symlinks in every caller-controlled
// component below it.
function normalizeHostPath(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const [top, ...rest] = absolute.slice(root.length).split(sep).filter(Boolean);
  if (top === undefined) return root;
  const topPath = join(root, top);
  if (lstatIfExists(topPath) === null) return absolute;
  return join(fs.realpathSync.native(topPath), ...rest);
}

function directoryComponents(path: string): string[] {
  const absolute = normalizeHostPath(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  const components = [root];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    components.push(current);
  }
  return components;
}

function validateExistingDirectories(path: string): void {
  for (const component of directoryComponents(path)) {
    const stats = lstatIfExists(component);
    if (stats === null) return;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Atomic write parent must contain only real directories: ${component}`);
    }
  }
}

type DirectoryIdentity = { path: string; realPath: string; stats: Stats };

function readDirectoryIdentity(path: string): DirectoryIdentity {
  const stats = fs.lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Atomic write parent must be a real directory: ${path}`);
  }
  return { path, realPath: fs.realpathSync.native(path), stats };
}

function assertDirectoryIdentity(identity: DirectoryIdentity): void {
  const current = lstatIfExists(identity.path);
  if (
    current === null ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameIdentity(identity.stats, current) ||
    fs.realpathSync.native(identity.path) !== identity.realPath
  ) {
    throw new Error(`Atomic write parent changed during publication: ${identity.path}`);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = errorCode(error);
  return (
    process.platform !== 'linux' &&
    code !== undefined &&
    UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(code)
  );
}

/** Strict on Linux; known unsupported directory-sync operations are tolerated elsewhere. */
export function syncDirectory(path: string): void {
  const normalized = normalizeHostPath(path);
  validateExistingDirectories(normalized);
  const identity = readDirectoryIdentity(normalized);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      identity.path,
      fs.constants.O_RDONLY | optionalOpenFlag('O_DIRECTORY') | optionalOpenFlag('O_NOFOLLOW'),
    );
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  }

  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory() || !sameIdentity(identity.stats, opened)) {
      throw new Error(`Directory changed before durability sync: ${identity.path}`);
    }
    try {
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Write a complete file through a unique same-directory temporary file.
 *
 * Existing parent components are checked before directory creation, and the
 * parent identity is checked around rename. These checks reject static symlink
 * escapes and detectable replacement; no pathname-only API can exclude every
 * mutation by another process running as the same user.
 */
export function writeFileAtomic(path: string, content: string | Uint8Array, mode?: number): void {
  const target = normalizeHostPath(path);
  const parentPath = dirname(target);
  validateExistingDirectories(parentPath);
  fs.mkdirSync(parentPath, { recursive: true });
  validateExistingDirectories(parentPath);
  const parent = readDirectoryIdentity(parentPath);
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(
    temporaryPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      optionalOpenFlag('O_NOFOLLOW'),
    mode ?? 0o666,
  );
  const temporaryStats = fs.fstatSync(descriptor);
  let published = false;

  try {
    if (!temporaryStats.isFile() || temporaryStats.nlink !== 1) {
      throw new Error(
        `Atomic write staging path must be a singly linked regular file: ${temporaryPath}`,
      );
    }
    if (mode !== undefined) fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    assertDirectoryIdentity(parent);
    const staged = fs.lstatSync(temporaryPath);
    if (
      staged.isSymbolicLink() ||
      !staged.isFile() ||
      staged.nlink !== 1 ||
      !sameIdentity(temporaryStats, staged)
    ) {
      throw new Error(`Atomic write staging path changed during publication: ${temporaryPath}`);
    }
    assertDirectoryIdentity(parent);
    fs.renameSync(temporaryPath, target);
    published = true;

    assertDirectoryIdentity(parent);
    const installed = fs.lstatSync(target);
    if (
      !installed.isFile() ||
      installed.isSymbolicLink() ||
      installed.nlink !== 1 ||
      !sameIdentity(temporaryStats, installed)
    ) {
      throw new Error(`Atomic write target changed during publication: ${target}`);
    }
    syncDirectory(parentPath);
    assertDirectoryIdentity(parent);
  } finally {
    fs.closeSync(descriptor);
    if (!published) {
      try {
        const current = fs.lstatSync(temporaryPath);
        if (sameIdentity(temporaryStats, current)) fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original failure; cleanup is only for our unique temp.
      }
    }
  }
}

/**
 * Write while keeping the file's inode. Required for single-file bind-mount
 * sources (auth.json): a rename gives the host a new inode while running
 * containers keep the old one, so they silently stop seeing host writes.
 * Not atomic: a reader can observe a short file mid-write.
 */
export function writeFileInPlace(path: string, content: string | Uint8Array, mode?: number): void {
  const tmp = `${path}.${process.pid}.inplace.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : {});
    fs.copyFileSync(tmp, path);
    if (mode !== undefined) fs.chmodSync(path, mode);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
