import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { secretsDir as secretsDirPath, stateSecretsDir as stateSecretsDirPath } from './home.js';
import { randomHex } from './crypto.js';
import { writeFileAtomic, writeFileInPlace } from './fs-atomic.js';

const SECRET_NAME_RE = /^[a-z0-9][a-z0-9_]{0,80}$/;
const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

function validateSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`);
}

/**
 * The secret files the Assistant agent is allowed to read — the ONE explicit
 * exception to default-deny routing. Every other name, including every name
 * nobody has thought of yet, resolves to `stateSecretsDir()`, which is never
 * mounted into the assistant.
 *
 * `auth.json` is OpenCode's provider auth. The assistant's own OpenCode process
 * reads it at `/home/opencode/.local/share/opencode/auth.json`, a single-file
 * bind mount of `knowledge/secrets/auth.json` (core.compose.yml), and it is the
 * only `knowledge/secrets` path any managed compose file names.
 *
 * A2: this is the inverse of the hand-maintained list it replaces. Under that
 * one an unlisted secret defaulted into the agent-readable tree, which is how
 * `op_session_signing_key` — the key that signs host-admin cookies — became
 * readable from /stash. A name forgotten here costs nothing: it stays private.
 */
export const AGENT_READABLE_SECRET_NAMES: ReadonlySet<string> = new Set(['auth.json']);

export function isAgentReadableSecretName(name: string): boolean {
  return AGENT_READABLE_SECRET_NAMES.has(name);
}

/**
 * Resolve (and harden) the DEFAULT secrets dir for an OP_HOME —
 * `${home}/state/secrets` (home.ts `stateSecretsDir`). Never bind-mounted
 * into the Assistant stash. Container consumers receive named Compose secret
 * files; host consumers read the same state files directly. Same hardening
 * as `resolveSecretsDir`.
 */
export function resolveStateSecretsDir(homeDir: string): string {
  const dir = stateSecretsDirPath(homeDir);
  mkdirSync(dir, { recursive: true, mode: SECRETS_DIR_MODE });
  chmodSync(dir, SECRETS_DIR_MODE);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) chmodSync(join(dir, entry.name), SECRET_FILE_MODE);
  }
  return dir;
}

/**
 * Resolve (and harden) the AGENT-READABLE secrets dir for an OP_HOME. The
 * location comes from the single source of truth (home.ts `secretsDir`) —
 * `knowledge/secrets`, the AKM stash's own secrets asset dir, derived from
 * `homeDir` alone, never inferred from a sibling path. Only the names in
 * `AGENT_READABLE_SECRET_NAMES` route here. Ensures 0700 on the dir and 0600
 * on its files.
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
 * automatically, with no call-site changes required. Default-deny: the state
 * tree unless the name is explicitly agent-readable
 * (AGENT_READABLE_SECRET_NAMES). Shared by both the strict SECRET_NAME_RE API
 * (secretPath) and the looser basename API (the admin Secrets-tab file
 * browser) — neither validates the name here, callers do that first.
 */
function resolveSecretsDirForName(homeDir: string, name: string): string {
  return isAgentReadableSecretName(name) ? resolveSecretsDir(homeDir) : resolveStateSecretsDir(homeDir);
}

/**
 * Both secrets dirs, each paired with the routing predicate that owns it —
 * the listing form of `resolveSecretsDirForName`, and the reason no listing
 * here merges the two trees implicitly any more.
 *
 * A file is listed ONLY from the dir its own name routes to. Under default-deny
 * an agent-readable-tree file whose name is not on the allowlist is unreachable
 * through readSecret/readSecretFile, so listing it would hand callers a name
 * that reads back as missing — and a write against it would create a second
 * copy in the state tree while the /stash-visible original quietly survived.
 * The two predicates are complements, so a name can never be listed twice and
 * the old "state entry shadows the knowledge one" rule has nothing left to do.
 */
function routedSecretsDirs(homeDir: string): Array<{ dir: string; owns: (name: string) => boolean }> {
  return [
    { dir: resolveSecretsDir(homeDir), owns: isAgentReadableSecretName },
    { dir: resolveStateSecretsDir(homeDir), owns: (name) => !isAgentReadableSecretName(name) },
  ];
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
  // K5 residual: tmp + rename, not a direct write. A kill mid-write of a
  // direct writeFileSync can leave a partial-but-non-empty file — ensureSecret's
  // torn-write check above only catches a 0-byte file, so a partial write would
  // be read back as a "valid" secret. Harmless for a generated random (re-run
  // regenerates it), but a partially-written wizard-supplied UI login password
  // would silently lock the operator out until `openpalm reset-password`.
  //
  // Safe to rename here (unlike writeSecretFile's auth.json case below):
  // SECRET_NAME_RE forbids dots, so this never targets auth.json — the one
  // agent-readable name — and therefore always lands on a `state/secrets/*`
  // file, which is never bind-mounted, only handed to containers as a Compose
  // `secrets: file:` entry copied in at container-create time, so a new inode
  // is irrelevant. Only a mount of one SPECIFIC file (auth.json's separate
  // bind, see writeFileInPlace's docblock) breaks on rename.
  writeFileAtomic(path, value, SECRET_FILE_MODE);
  chmodSync(path, SECRET_FILE_MODE);
}

export function ensureSecret(homeDir: string, name: string, valueFactory: () => string): string {
  const path = secretPath(homeDir, name);
  // A torn write (process killed mid-write) can leave a 0-byte secret file.
  // Treat that the same as missing so it gets re-seeded instead of being
  // returned (and depended on) as a permanent empty string.
  const torn = existsSync(path) && statSync(path).size === 0;
  const existing = torn ? null : readSecret(homeDir, name);
  // A non-empty file is the operator's, whatever is in it. This deliberately
  // does NOT re-seed a blank-but-nonzero file (one newline): that was a guard
  // added to stop a blank `op_opencode_password` bricking the stack, which is
  // the wrong end to fix — silently rewriting a file someone put there is not
  // this function's business. The boot path no longer treats blank as fatal.
  if (existing !== null) return existing;
  const value = valueFactory();
  writeSecret(homeDir, name, value);
  return value;
}

export function removeSecret(homeDir: string, name: string): void {
  rmSync(secretPath(homeDir, name), { force: true });
}

/**
 * Every secret NAME the name-routed API resolves to a real file, alphabetically
 * sorted. Callers never need to know which physical directory a given name
 * lives in — `readSecret`/`writeSecret`/etc. route by name via `secretPath`,
 * and `routedSecretsDirs` guarantees this listing agrees with that routing.
 */
export function listSecretNames(homeDir: string): string[] {
  const names: string[] = [];
  for (const { dir, owns } of routedSecretsDirs(homeDir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && SECRET_NAME_RE.test(entry.name) && owns(entry.name)) names.push(entry.name);
    }
  }
  return names.sort();
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
 * List every regular file the basename API can reach, with byte size — the
 * state tree, plus the agent-readable tree for the allowlisted names only
 * (that is what puts `auth.json` in the Secrets tab). Same `routedSecretsDirs`
 * rule as `listSecretNames`: the tab never lists a file it would then read or
 * write somewhere else.
 */
export function listSecretFiles(homeDir: string): SecretFileInfo[] {
  const files: SecretFileInfo[] = [];
  for (const { dir, owns } of routedSecretsDirs(homeDir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !SECRET_FILENAME_RE.test(entry.name) || entry.name.includes('..')) continue;
      if (!owns(entry.name)) continue;
      files.push({ name: entry.name, size: statSync(join(dir, entry.name)).size });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a secrets-dir file by basename (raw contents), or null if absent. */
export function readSecretFile(homeDir: string, name: string): string | null {
  assertSafeSecretFilename(name);
  const path = join(resolveSecretsDirForName(homeDir, name), name);
  if (!existsSync(path)) return null;
  chmodSync(path, SECRET_FILE_MODE);
  return readFileSync(path, 'utf-8');
}

/**
 * Write a secrets-dir file by basename (0600).
 *
 * Unlike writeSecret(), this is the admin Secrets-tab file browser's raw
 * write path and it DOES reach `auth.json` (SECRET_FILENAME_RE allows dots).
 * `auth.json` is bind-mounted as a single file, not a directory
 * (core.compose.yml), so a tmp+rename write would swap it for a new inode
 * while the running assistant container keeps the old, now-unlinked one open
 * — the container silently stops seeing host writes. writeFileInPlace keeps
 * the destination's inode (and, since it writes into the existing file rather
 * than renaming a new one over it, the destination's owner too). Applied to
 * every name this function handles, not just auth.json, since all of them are
 * reachable from the same admin editor and none benefit from tmp+rename here.
 */
export function writeSecretFile(homeDir: string, name: string, value: string): void {
  assertSafeSecretFilename(name);
  const path = join(resolveSecretsDirForName(homeDir, name), name);
  writeFileInPlace(path, value, SECRET_FILE_MODE);
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
