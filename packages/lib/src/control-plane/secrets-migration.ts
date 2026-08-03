/**
 * Relocate delegated credentials from Assistant-readable knowledge/secrets to
 * private/secrets. Copies are made durable and verified before the old pathname
 * is unlinked; differing copies are always preserved for manual resolution.
 *
 * Node has no portable unlink-by-handle or compare-and-rename primitive. The
 * identity/content checks below catch static links and observable concurrent
 * edits, but another process running as the same user can still mutate a path
 * in the final check-to-unlink window. OpenPalm serializes lifecycle commands;
 * this migration does not attempt to build a filesystem transaction manager.
 */
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../logger.js';
import { syncDirectory } from './fs-atomic.js';
import { privateDir, privateSecretsDir, secretsDir } from './home.js';
import { DELEGATED_SECRET_NAMES } from './secrets-files.js';

const logger = createLogger('secrets-migration');
const DIRECTORY_MODE = 0o700;
const SECRET_MODE = 0o600;
const LINK_FALLBACK_ERRORS = new Set([
  'EACCES',
  'EXDEV',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
]);

type DirectorySnapshot = { path: string; stats: Stats };
type SecretSnapshot = { bytes: Buffer; stats: Stats };

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

function assertDirectory(path: string, label: string): DirectorySnapshot {
  const stats = fs.lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return { path, stats };
}

function optionalDirectory(path: string, label: string): DirectorySnapshot | null {
  const stats = lstatIfExists(path);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return { path, stats };
}

function ensurePrivateDirectory(path: string, label: string): DirectorySnapshot {
  if (lstatIfExists(path) === null) {
    fs.mkdirSync(path, { mode: DIRECTORY_MODE });
    syncDirectory(dirname(path));
  }
  assertDirectory(path, label);
  fs.chmodSync(path, DIRECTORY_MODE);
  const directory = assertDirectory(path, label);
  syncKnownDirectory(directory);
  return directory;
}

function assertDirectoryCurrent(directory: DirectorySnapshot): void {
  const current = lstatIfExists(directory.path);
  if (
    current === null ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameIdentity(directory.stats, current)
  ) {
    throw new Error(`Secret directory changed during migration: ${directory.path}`);
  }
}

function syncKnownDirectory(directory: DirectorySnapshot): void {
  assertDirectoryCurrent(directory);
  syncDirectory(directory.path);
  assertDirectoryCurrent(directory);
}

function finishInterruptedPublication(
  directory: DirectorySnapshot,
  name: string,
  destinationPath: string,
): void {
  const destination = lstatIfExists(destinationPath);
  if (destination === null || destination.nlink === 1) return;
  const prefix = `.openpalm-secret-${name}-`;
  const linkedTemps = fs
    .readdirSync(directory.path)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'))
    .map((entry) => join(directory.path, entry))
    .filter((path) => {
      const stats = lstatIfExists(path);
      return stats?.isFile() && sameIdentity(destination, stats);
    });
  if (destination.nlink !== 2 || linkedTemps.length !== 1) return;
  fs.unlinkSync(linkedTemps[0]);
  syncKnownDirectory(directory);
}

function assertRegularSecret(stats: Stats, path: string): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error(
      `Delegated secret must be a regular file without symbolic or hard links: ${path}`,
    );
  }
}

function openSecret(path: string, flags: number, mode?: number): number {
  try {
    return fs.openSync(
      path,
      flags | optionalOpenFlag('O_NOFOLLOW') | optionalOpenFlag('O_NONBLOCK'),
      mode,
    );
  } catch (error) {
    if (errorCode(error) === 'ELOOP') {
      throw new Error(`Delegated secret must not be a symbolic link: ${path}`);
    }
    throw error;
  }
}

function readSecret(path: string): SecretSnapshot | null {
  const before = lstatIfExists(path);
  if (before === null) return null;
  assertRegularSecret(before, path);

  let descriptor: number;
  try {
    descriptor = openSecret(path, fs.constants.O_RDONLY);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }

  try {
    const opened = fs.fstatSync(descriptor);
    assertRegularSecret(opened, path);
    if (!sameSnapshot(before, opened))
      throw new Error(`Delegated secret changed during migration: ${path}`);
    const bytes = fs.readFileSync(descriptor);
    const descriptorAfter = fs.fstatSync(descriptor);
    const after = lstatIfExists(path);
    if (after === null) throw new Error(`Delegated secret changed during migration: ${path}`);
    assertRegularSecret(descriptorAfter, path);
    assertRegularSecret(after, path);
    if (
      bytes.byteLength !== opened.size ||
      !sameSnapshot(opened, descriptorAfter) ||
      !sameSnapshot(descriptorAfter, after)
    ) {
      throw new Error(`Delegated secret changed during migration: ${path}`);
    }
    return { bytes, stats: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

function hardenDestination(path: string): SecretSnapshot | null {
  const before = readSecret(path);
  if (before === null) return null;
  fs.chmodSync(path, SECRET_MODE);

  const hardened = readSecret(path);
  if (hardened === null || !sameIdentity(before.stats, hardened.stats)) {
    throw new Error(`Delegated secret destination changed while setting permissions: ${path}`);
  }
  const descriptor = openSecret(path, fs.constants.O_RDWR);
  let durable = hardened.stats;
  try {
    const opened = fs.fstatSync(descriptor);
    assertRegularSecret(opened, path);
    if (!sameSnapshot(hardened.stats, opened)) {
      throw new Error(`Delegated secret destination changed during durability sync: ${path}`);
    }
    fs.fchmodSync(descriptor, SECRET_MODE);
    fs.fsyncSync(descriptor);
    durable = fs.fstatSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const current = readSecret(path);
  if (
    current === null ||
    !sameSnapshot(durable, current.stats) ||
    !hardened.bytes.equals(current.bytes) ||
    (current.stats.mode & 0o777) !== SECRET_MODE
  ) {
    throw new Error(`Delegated secret destination changed during durability sync: ${path}`);
  }
  return current;
}

function publishDestination(
  directory: DirectorySnapshot,
  name: string,
  destinationPath: string,
  bytes: Buffer,
): SecretSnapshot | null {
  const temporaryPath = join(
    directory.path,
    `.openpalm-secret-${name}-${process.pid}-${randomUUID()}.tmp`,
  );
  const descriptor = openSecret(
    temporaryPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    SECRET_MODE,
  );
  const temporaryStats = fs.fstatSync(descriptor);

  try {
    fs.fchmodSync(descriptor, SECRET_MODE);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }

  try {
    assertDirectoryCurrent(directory);
    const staged = readSecret(temporaryPath);
    if (
      staged === null ||
      !sameIdentity(temporaryStats, staged.stats) ||
      !staged.bytes.equals(bytes)
    ) {
      throw new Error(`Delegated secret staging file changed before publication: ${temporaryPath}`);
    }
    assertDirectoryCurrent(directory);
    try {
      fs.linkSync(temporaryPath, destinationPath);
    } catch (error) {
			const code = errorCode(error);
			if (code === 'EEXIST') return null;
			if (code === undefined || !LINK_FALLBACK_ERRORS.has(code)) throw error;
			if (lstatIfExists(destinationPath) !== null) return null;
			try {
        fs.copyFileSync(temporaryPath, destinationPath, fs.constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (errorCode(copyError) === 'EEXIST') return null;
        throw copyError;
      }
    }

    fs.unlinkSync(temporaryPath);
    const destination = hardenDestination(destinationPath);
    if (destination === null || !destination.bytes.equals(bytes)) {
      throw new Error(`Delegated secret destination failed verification: ${destinationPath}`);
    }
    syncKnownDirectory(directory);
    return destination;
  } finally {
    try {
      const current = fs.lstatSync(temporaryPath);
      if (sameIdentity(temporaryStats, current)) fs.unlinkSync(temporaryPath);
    } catch {
      // Preserve the migration failure; this path names only our unique temp.
    }
  }
}

function removeVerifiedSource(
  sourcePath: string,
  source: SecretSnapshot,
  sourceDirectory: DirectorySnapshot,
  destinationPath: string,
  destination: SecretSnapshot,
): void {
  assertDirectoryCurrent(sourceDirectory);
  const currentSource = readSecret(sourcePath);
  const currentDestination = readSecret(destinationPath);
  if (
    currentSource === null ||
    currentDestination === null ||
    !sameIdentity(source.stats, currentSource.stats) ||
    !sameIdentity(destination.stats, currentDestination.stats) ||
    !source.bytes.equals(currentSource.bytes) ||
    !source.bytes.equals(currentDestination.bytes)
  ) {
    throw new Error(`Delegated secret changed before source removal: ${sourcePath}`);
  }

  // Intentional security migration: the verified private copy now owns these
  // bytes, so the Assistant-readable source pathname must be removed.
  fs.unlinkSync(sourcePath);
  syncKnownDirectory(sourceDirectory);
}

export type DelegatedSecretMigrationResult = {
  migrated: string[];
  alreadyMigrated: string[];
  skippedMismatch: string[];
  absent: string[];
};

export function migrateDelegatedSecretsToPrivateDir(
  homeDir: string,
): DelegatedSecretMigrationResult {
  assertDirectory(homeDir, 'OP_HOME');
  const knowledge = optionalDirectory(join(homeDir, 'knowledge'), 'Knowledge directory');
  const sourceDirectory =
    knowledge === null
      ? null
      : optionalDirectory(secretsDir(homeDir), 'Knowledge secrets directory');
  const privateDirectory = ensurePrivateDirectory(privateDir(homeDir), 'Private directory');
  const destinationDirectory = ensurePrivateDirectory(
    privateSecretsDir(homeDir),
    'Private secrets directory',
  );
  assertDirectoryCurrent(privateDirectory);
  if (sourceDirectory !== null && sameIdentity(sourceDirectory.stats, destinationDirectory.stats)) {
    throw new Error('Knowledge and private secrets directories must not alias each other');
  }

  const result: DelegatedSecretMigrationResult = {
    migrated: [],
    alreadyMigrated: [],
    skippedMismatch: [],
    absent: [],
  };

  // Harden every delegated destination before any source can fail validation.
  const destinations = new Map<string, SecretSnapshot>();
  for (const name of DELEGATED_SECRET_NAMES) {
    assertDirectoryCurrent(destinationDirectory);
    const destinationPath = join(destinationDirectory.path, name);
    finishInterruptedPublication(destinationDirectory, name, destinationPath);
    const destination = hardenDestination(destinationPath);
    if (destination !== null) destinations.set(name, destination);
  }

  for (const name of DELEGATED_SECRET_NAMES) {
    const sourcePath = join(secretsDir(homeDir), name);
    const destinationPath = join(destinationDirectory.path, name);
    if (sourceDirectory !== null) assertDirectoryCurrent(sourceDirectory);
    assertDirectoryCurrent(destinationDirectory);
    const source = sourceDirectory === null ? null : readSecret(sourcePath);
    let destination = destinations.get(name) ?? null;

    if (source === null && destination === null) {
      result.absent.push(name);
      continue;
    }
    if (source === null) {
      if (sourceDirectory !== null) syncKnownDirectory(sourceDirectory);
      syncKnownDirectory(destinationDirectory);
      result.alreadyMigrated.push(name);
      continue;
    }
    if (sourceDirectory === null)
      throw new Error(`Delegated secret source directory disappeared: ${sourcePath}`);

    let destinationIsDurable = false;
    if (destination === null) {
      destination = publishDestination(destinationDirectory, name, destinationPath, source.bytes);
      destinationIsDurable = destination !== null;
      if (destination === null) destination = hardenDestination(destinationPath);
      if (destination === null)
        throw new Error(`Delegated secret destination disappeared: ${destinationPath}`);
    }

    if (!destination.bytes.equals(source.bytes)) {
      result.skippedMismatch.push(name);
      logger.warn('delegated secret copies differ; preserving both for manual resolution', {
        name,
        sourcePath,
        destinationPath,
      });
      continue;
    }

    if (!destinationIsDurable) syncKnownDirectory(destinationDirectory);
    removeVerifiedSource(sourcePath, source, sourceDirectory, destinationPath, destination);
    result.migrated.push(name);
    logger.warn('migrated delegated secret out of the Assistant-readable knowledge tree', {
      name,
      sourcePath,
      destinationPath,
    });
  }

  return result;
}
