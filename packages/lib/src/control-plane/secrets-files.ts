import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const SECRET_NAME_RE = /^[a-z0-9][a-z0-9_]{0,80}$/;
const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

export function validateSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`);
}

function resolveHomeDirFromStackDir(stackDir: string): string {
  const parentDir = dirname(stackDir);
  if (basename(stackDir) === 'stack' && basename(parentDir) === 'config') {
    return dirname(parentDir);
  }
  return stackDir;
}

export function resolveSecretsDir(stackDir: string): string {
  const dir = join(resolveHomeDirFromStackDir(stackDir), 'stash', 'vaults', 'secrets');
  mkdirSync(dir, { recursive: true, mode: SECRETS_DIR_MODE });
  chmodSync(dir, SECRETS_DIR_MODE);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) chmodSync(join(dir, entry.name), SECRET_FILE_MODE);
  }
  return dir;
}

export function secretPath(stackDir: string, name: string): string {
  validateSecretName(name);
  return join(resolveSecretsDir(stackDir), name);
}

export function readSecret(stackDir: string, name: string): string | null {
  const path = secretPath(stackDir, name);
  if (!existsSync(path)) return null;
  chmodSync(path, SECRET_FILE_MODE);
  return readFileSync(path, 'utf-8');
}

export function writeSecret(stackDir: string, name: string, value: string): void {
  const path = secretPath(stackDir, name);
  writeFileSync(path, value, { mode: SECRET_FILE_MODE });
  chmodSync(path, SECRET_FILE_MODE);
}

export function ensureSecret(stackDir: string, name: string, valueFactory: () => string): string {
  const existing = readSecret(stackDir, name);
  if (existing !== null) return existing;
  const value = valueFactory();
  writeSecret(stackDir, name, value);
  return value;
}

export function removeSecret(stackDir: string, name: string): void {
  rmSync(secretPath(stackDir, name), { force: true });
}

export function listSecretNames(stackDir: string): string[] {
  const dir = resolveSecretsDir(stackDir);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SECRET_NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}
