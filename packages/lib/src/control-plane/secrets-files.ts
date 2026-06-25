import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretsDir as secretsDirPath } from './home.js';

const SECRET_NAME_RE = /^[a-z0-9][a-z0-9_]{0,80}$/;
const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

export function validateSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`);
}

/**
 * Resolve (and harden) the secrets dir for an OP_HOME. The location comes from
 * the single source of truth (home.ts `secretsDir`) — secrets are USER-owned
 * `knowledge/secrets`, derived from `homeDir` alone, never inferred from a
 * sibling path. Ensures 0700 on the dir and 0600 on its files.
 */
export function resolveSecretsDir(homeDir: string): string {
  const dir = secretsDirPath(homeDir);
  mkdirSync(dir, { recursive: true, mode: SECRETS_DIR_MODE });
  chmodSync(dir, SECRETS_DIR_MODE);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) chmodSync(join(dir, entry.name), SECRET_FILE_MODE);
  }
  return dir;
}

export function secretPath(homeDir: string, name: string): string {
  validateSecretName(name);
  return join(resolveSecretsDir(homeDir), name);
}

export function readSecret(homeDir: string, name: string): string | null {
  const path = secretPath(homeDir, name);
  if (!existsSync(path)) return null;
  chmodSync(path, SECRET_FILE_MODE);
  return readFileSync(path, 'utf-8');
}

export function writeSecret(homeDir: string, name: string, value: string): void {
  const path = secretPath(homeDir, name);
  writeFileSync(path, value, { mode: SECRET_FILE_MODE });
  chmodSync(path, SECRET_FILE_MODE);
}

export function ensureSecret(homeDir: string, name: string, valueFactory: () => string): string {
  const existing = readSecret(homeDir, name);
  if (existing !== null) return existing;
  const value = valueFactory();
  writeSecret(homeDir, name, value);
  return value;
}

export function removeSecret(homeDir: string, name: string): void {
  rmSync(secretPath(homeDir, name), { force: true });
}

export function listSecretNames(homeDir: string): string[] {
  const dir = resolveSecretsDir(homeDir);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SECRET_NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// ── Raw file access for the Secrets admin tab ──────────────────────────────
// The admin Secrets tab is a plain file browser/editor for the secrets dir, so
// it must reach files the strict SECRET_NAME_RE excludes (e.g. `auth.json`). The
// filename guard below permits dots/dashes but is still traversal-safe (no path
// separators, no `..`). Names are always basenames within the secrets dir.
const SECRET_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeSecretFilename(name: string): void {
  if (!SECRET_FILENAME_RE.test(name) || name.includes('..')) {
    throw new Error(`Invalid secret file name: ${name}`);
  }
}

export type SecretFileInfo = { name: string; size: number };

/** List every regular file in the secrets dir (incl. auth.json), with byte size. */
export function listSecretFiles(homeDir: string): SecretFileInfo[] {
  const dir = resolveSecretsDir(homeDir);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SECRET_FILENAME_RE.test(entry.name) && !entry.name.includes('..'))
    .map((entry) => ({ name: entry.name, size: statSync(join(dir, entry.name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a secrets-dir file by basename (raw contents), or null if absent. */
export function readSecretFile(homeDir: string, name: string): string | null {
  assertSafeSecretFilename(name);
  const path = join(resolveSecretsDir(homeDir), name);
  if (!existsSync(path)) return null;
  chmodSync(path, SECRET_FILE_MODE);
  return readFileSync(path, 'utf-8');
}

/** Write a secrets-dir file by basename (0600). */
export function writeSecretFile(homeDir: string, name: string, value: string): void {
  assertSafeSecretFilename(name);
  const path = join(resolveSecretsDir(homeDir), name);
  writeFileSync(path, value, { mode: SECRET_FILE_MODE });
  chmodSync(path, SECRET_FILE_MODE);
}

/** Delete a secrets-dir file by basename. */
export function removeSecretFile(homeDir: string, name: string): void {
  assertSafeSecretFilename(name);
  rmSync(join(resolveSecretsDir(homeDir), name), { force: true });
}
