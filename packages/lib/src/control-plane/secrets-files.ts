import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretsDir as secretsDirPath, privateSecretsDir as privateSecretsDirPath } from './home.js';
import { randomHex } from './crypto.js';
import { PORTAL_SECRET_ADDON_IDS } from './addon-ids.js';

const SECRET_NAME_RE = /^[a-z0-9][a-z0-9_]{0,80}$/;
const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

function validateSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`);
}

/**
 * Delegated service credentials are consumed by their UI, OpenCode server,
 * Guardian, API, portal, or bot process, never through the Assistant stash.
 * These are written to (and read from) `privateSecretsDir()` instead of the stash-visible
 * `secretsDir()`; every other secret name keeps living in `secretsDir()`
 * (notably `auth.json`, shared with the assistant's own OpenCode process).
 *
 * The portal principal secrets (`portal_<id>_secret`) are derived from
 * `PORTAL_SECRET_ADDON_IDS` — the same single source of truth
 * `ensurePortalSecret` uses — so this list can never drift from the set of
 * portal secrets actually provisioned.
 */
export const DELEGATED_SECRET_NAMES: ReadonlySet<string> = new Set([
  'op_guardian_admin_token',
  'op_guardian_mcp_token',
  'op_api_key',
  'discord_bot_token',
  'slack_bot_token',
  'slack_app_token',
  'op_opencode_password',
  'op_ui_login_password',
  // The HMAC key mixed into every session cookie. It belongs here for the same
  // reason op_ui_login_password does, and was missed when that one moved: with
  // the key readable from /stash, anything running inside the assistant — or
  // anything that prompt-injects it — can forge a valid host-admin session
  // cookie, which is precisely the attack the key exists to prevent.
  'op_session_signing_key',
  ...PORTAL_SECRET_ADDON_IDS.map(portalSecretName),
]);

export function isDelegatedSecretName(name: string): boolean {
  return DELEGATED_SECRET_NAMES.has(name);
}

/**
 * Resolve (and harden) the delegated-secrets dir for an OP_HOME —
 * `${home}/private/secrets` (home.ts `privateSecretsDir`). Never bind-mounted
 * into the Assistant stash. Container consumers receive named Compose secret
 * files; host consumers read the same private files directly. Same hardening
 * as `resolveSecretsDir`.
 */
export function resolvePrivateSecretsDir(homeDir: string): string {
  const dir = privateSecretsDirPath(homeDir);
  mkdirSync(dir, { recursive: true, mode: SECRETS_DIR_MODE });
  chmodSync(dir, SECRETS_DIR_MODE);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) chmodSync(join(dir, entry.name), SECRET_FILE_MODE);
  }
  return dir;
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

/**
 * The effective secrets dir for a given secret/file NAME — the routing point
 * that makes every generic call site (readSecret/writeSecret/ensureSecret/
 * patchSecretsEnvFile/readSecretFile/writeSecretFile/removeSecretFile, all of
 * which take a name and never a directory) resolve to the correct location
 * automatically, delegated or not, with no call-site changes required. See
 * DELEGATED_SECRET_NAMES. Shared by both the strict SECRET_NAME_RE API
 * (secretPath) and the looser basename API (the admin Secrets-tab file
 * browser) — neither validates the name here, callers do that first.
 */
function resolveSecretsDirForName(homeDir: string, name: string): string {
  return isDelegatedSecretName(name) ? resolvePrivateSecretsDir(homeDir) : resolveSecretsDir(homeDir);
}

export function secretPath(homeDir: string, name: string): string {
  validateSecretName(name);
  return join(resolveSecretsDirForName(homeDir, name), name);
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
  const path = secretPath(homeDir, name);
  // A torn write (process killed mid-write) can leave a 0-byte secret file.
  // Treat that the same as missing so it gets re-seeded instead of being
  // returned (and depended on) as a permanent empty string.
  const torn = existsSync(path) && statSync(path).size === 0;
  const existing = torn ? null : readSecret(homeDir, name);
  if (existing !== null) return existing;
  const value = valueFactory();
  writeSecret(homeDir, name, value);
  return value;
}

export function removeSecret(homeDir: string, name: string): void {
  rmSync(secretPath(homeDir, name), { force: true });
}

/**
 * Every secret NAME across both dirs (`secretsDir()` and the delegated
 * `privateSecretsDir()`), merged into one alphabetically-sorted list. Callers
 * never need to know which physical directory a given name lives in —
 * `readSecret`/`writeSecret`/etc. route by name via `secretPath`.
 */
export function listSecretNames(homeDir: string): string[] {
  const names = new Set<string>();
  for (const dir of [resolveSecretsDir(homeDir), resolvePrivateSecretsDir(homeDir)]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && SECRET_NAME_RE.test(entry.name)) names.add(entry.name);
    }
  }
  return [...names].sort();
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

/**
 * List every regular file across both secrets dirs (incl. auth.json), with
 * byte size. Delegated names are looked up in `privateSecretsDir()`; a stray
 * same-named leftover in `secretsDir()` (an interrupted migration) is
 * shadowed by the private entry rather than duplicated in the listing.
 */
export function listSecretFiles(homeDir: string): SecretFileInfo[] {
  const files = new Map<string, SecretFileInfo>();
  for (const dir of [resolveSecretsDir(homeDir), resolvePrivateSecretsDir(homeDir)]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !SECRET_FILENAME_RE.test(entry.name) || entry.name.includes('..')) continue;
      files.set(entry.name, { name: entry.name, size: statSync(join(dir, entry.name)).size });
    }
  }
  return [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a secrets-dir file by basename (raw contents), or null if absent. */
export function readSecretFile(homeDir: string, name: string): string | null {
  assertSafeSecretFilename(name);
  const path = join(resolveSecretsDirForName(homeDir, name), name);
  if (!existsSync(path)) return null;
  chmodSync(path, SECRET_FILE_MODE);
  return readFileSync(path, 'utf-8');
}

/** Write a secrets-dir file by basename (0600). */
export function writeSecretFile(homeDir: string, name: string, value: string): void {
  assertSafeSecretFilename(name);
  const path = join(resolveSecretsDirForName(homeDir, name), name);
  writeFileSync(path, value, { mode: SECRET_FILE_MODE });
  chmodSync(path, SECRET_FILE_MODE);
}

/** Delete a secrets-dir file by basename. */
export function removeSecretFile(homeDir: string, name: string): void {
  assertSafeSecretFilename(name);
  rmSync(join(resolveSecretsDirForName(homeDir, name), name), { force: true });
}

// ── Portal principal secrets ─────────────────────────────────────────────────

/** `discord` -> `portal_discord_secret`. */
export function portalSecretName(addon: string): string {
  return `portal_${addon.replace(/-/g, '_')}_secret`;
}

/**
 * Seed a portal's principal secret if absent, returning the value either way.
 *
 * Lives here rather than in config-persistence.ts so `ensureSecrets` can call
 * it without an import cycle: portals.compose.yml declares all four portal
 * secrets as top-level file secrets, so the files must exist on every install
 * regardless of which portals are enabled.
 */
export function ensurePortalSecret(homeDir: string, addon: string): string {
  return ensureSecret(homeDir, portalSecretName(addon), () => randomHex(16));
}
