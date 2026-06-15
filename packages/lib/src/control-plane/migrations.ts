/**
 * On-disk layout migration harness.
 *
 * `stack.env` carries `OP_LAYOUT_VERSION` — the authoritative marker of the
 * home-directory layout schema. `ensureMigrated()` runs BEFORE any state
 * validation (createState/resolveRuntimeFiles assume the current layout), so it
 * must resolve its own paths rather than take a built ControlPlaneState.
 *
 * Contract (the fail-safe invariant):
 *   - Fast path: if the layout is already current, return immediately — no lock,
 *     no backup, zero overhead on routine updates.
 *   - Otherwise: acquire the install lock, take a FULL-HOME backup first, and
 *     abort the whole upgrade if the backup fails (never migrate without a
 *     verified safety copy).
 *   - Migrations are additive for USER data (never delete/overwrite user files;
 *     relocate, don't drop). They MAY remove SYSTEM-managed inert files (e.g. a
 *     compose overlay the control plane no longer loads) via an explicit
 *     allowlist — but only because the FULL-HOME backup above runs first, so the
 *     home stays fully recoverable. Never a heuristic sweep, never user data.
 *   - The OP_LAYOUT_VERSION bump is the LAST step (the commit point); a crash
 *     before it just re-runs next time (idempotent).
 *   - On failure, throw MigrationError carrying the backup path + recovery
 *     guidance for the CLI/UI to surface.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, statSync, chmodSync, cpSync, copyFileSync, renameSync, rmSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { parse as yamlParse } from "yaml";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import { backupOpenPalmHome, timestampDirName, checkBackupFreeSpace, describeBackupSpaceShortfall } from "./backup.js";
import { upsertEnvValue } from "./env.js";
import { nonSensitiveAddonEnvKeys } from "./addon-env-schemas.js";
import { PLATFORM_IMAGE_TAG_KEYS, buildPlatformImageTagEnv } from './image-tags.js';
import { compareComparableVersions, isComparableSemver } from './versioning.js';

export const LAYOUT_VERSION_KEY = "OP_LAYOUT_VERSION";
/** Bump when the on-disk layout changes and add a Migration to MIGRATIONS. */
export const CURRENT_LAYOUT_VERSION = 2;

const ADDON_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface MigrationReport {
  migrated: boolean;
  from: number;
  to: number;
  applied: string[];
  backupDir: string | null;
  notes: string[];
  releaseFrom: string | null;
  releaseTo: string;
  releaseApplied: string[];
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly guidance: string,
    readonly backupDir: string | null,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Thrown when the pre-backup free-space check estimates the safety backup would
 * exceed a safe fraction of free disk. Surfaced so callers (CLI/UI) can present
 * a plain-language warning and re-run with explicit confirmation. NOTHING is
 * deleted — the migration aborts cleanly with no changes made.
 */
export class BackupSpaceError extends MigrationError {
  constructor(
    message: string,
    guidance: string,
    readonly estimatedBytes: number,
    readonly freeBytes: number,
  ) {
    super(message, guidance, null);
    this.name = "BackupSpaceError";
  }
}

interface MigrationCtx {
  homeDir: string;
  dataDir: string;
  stackDir: string;
  stashDir: string;
  configDir: string;
  dryRun: boolean;
  log: (m: string) => void;
  notes: string[];
}

interface Migration {
  from: number;
  to: number;
  describe: string;
  apply(ctx: MigrationCtx): void;
  verify(ctx: MigrationCtx): void;
}

interface ReleaseMigration {
  version: string;
  describe: string;
  apply(ctx: MigrationCtx): void;
  verify(ctx: MigrationCtx): void;
}

export interface ReleaseMigrationReport {
  migrated: boolean;
  from: string | null;
  to: string;
  applied: string[];
  backupDir: string | null;
  notes: string[];
}

const RELEASE_VERSION_KEY = 'OP_RELEASE_VERSION';

function resolveMigrationPaths(homeDir: string): Pick<MigrationCtx, 'homeDir' | 'dataDir' | 'stackDir' | 'stashDir' | 'configDir'> {
  return {
    homeDir,
    dataDir: join(homeDir, 'data'),
    stackDir: join(homeDir, 'config', 'stack'),
    stashDir: join(homeDir, 'knowledge'),
    configDir: join(homeDir, 'config'),
  };
}

function selectPendingReleaseMigrations(
  releaseFrom: string | null,
  targetVersion: string,
): ReleaseMigration[] {
  if (!isComparableSemver(targetVersion)) return [];

  return RELEASE_MIGRATIONS
    .filter((migration) => {
      if (!isComparableSemver(migration.version)) return false;
      if (compareComparableVersions(migration.version, targetVersion) > 0) return false;
      if (releaseFrom === null || !isComparableSemver(releaseFrom)) return true;
      return compareComparableVersions(migration.version, releaseFrom) > 0;
    })
    .sort((a, b) => compareComparableVersions(a.version, b.version));
}

// ── Layout-version read/write (stack.env is the single source of truth) ───────

function stackEnvFile(stashDir: string): string {
  return join(stashDir, "env", "stack.env");
}

function readStackEnvValue(stashDir: string, key: string): string | null {
  const envPath = stackEnvFile(stashDir);
  if (!existsSync(envPath)) return null;

  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(new RegExp(`^${key}=(.+)\\s*$`));
    if (match) return match[1].trim();
  }

  return null;
}

/**
 * Resolve the current on-disk layout version.
 *   - explicit OP_LAYOUT_VERSION in knowledge/env/stack.env wins
 *   - else a top-level `vault/` directory ⇒ 0.10.x layout (version 0)
 *   - else assume the current layout (a pre-marker 0.11 install) — caller stamps it
 */
function readLayoutVersion(ctx: { homeDir: string; stashDir: string }): number {
  const envPath = stackEnvFile(ctx.stashDir);
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^OP_LAYOUT_VERSION=(\d+)\s*$/);
      if (m) return Number(m[1]);
    }
  }
  if (existsSync(join(ctx.homeDir, "vault"))) return 0;
  return CURRENT_LAYOUT_VERSION;
}

function readStampedLayoutVersion(stashDir: string): number | null {
  const raw = readStackEnvValue(stashDir, LAYOUT_VERSION_KEY);
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function stampLayoutVersion(stashDir: string, version: number): boolean {
  const envPath = stackEnvFile(stashDir);
  if (!existsSync(envPath)) return false; // nothing to stamp; not a usable install
  const current = readFileSync(envPath, 'utf-8');
  const next = upsertEnvValue(current, LAYOUT_VERSION_KEY, String(version));
  if (next === current) return false;
  writeFileSync(envPath, next);
  return true;
}

function readReleaseVersion(stashDir: string): string | null {
  return readStampedReleaseVersion(stashDir) ?? readImageTag(stashDir);
}

function readStampedReleaseVersion(stashDir: string): string | null {
  return readStackEnvValue(stashDir, RELEASE_VERSION_KEY);
}

function readImageTag(stashDir: string): string | null {
  return readStackEnvValue(stashDir, 'OP_IMAGE_TAG');
}

function stampReleaseVersion(stashDir: string, version: string): boolean {
  const envPath = stackEnvFile(stashDir);
  if (!existsSync(envPath)) return false;
  const current = readFileSync(envPath, 'utf-8');
  const next = upsertEnvValue(current, RELEASE_VERSION_KEY, version);
  if (next === current) return false;
  writeFileSync(envPath, next);
  return true;
}

function upsertMany(content: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (next, [key, value]) => upsertEnvValue(next, key, value),
    content,
  );
}

// ── helpers (non-destructive: copy, never delete the source) ──────────────────

function ensureDir(ctx: MigrationCtx, dir: string): void {
  if (ctx.dryRun) { ctx.log(`[dry-run] mkdir ${rel(ctx, dir)}`); return; }
  mkdirSync(dir, { recursive: true });
  try { chmodSync(dir, 0o700); } catch { /* Windows / best-effort */ }
}

function rel(ctx: MigrationCtx, p: string): string {
  return p.startsWith(ctx.homeDir) ? p.slice(ctx.homeDir.length + 1) : p;
}

/** Copy src→dest; skip if dest exists; chmod 600. Returns true if copied. */
function copyIfAbsent(ctx: MigrationCtx, src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  if (existsSync(dest)) { ctx.log(`skip (exists): ${rel(ctx, dest)}`); return false; }
  if (ctx.dryRun) { ctx.log(`[dry-run] copy ${rel(ctx, src)} -> ${rel(ctx, dest)}`); return true; }
  cpSync(src, dest, { recursive: true });
  try { if (statSync(dest).isFile()) chmodSync(dest, 0o600); } catch { /* best-effort */ }
  ctx.log(`copied: ${rel(ctx, src)} -> ${rel(ctx, dest)}`);
  return true;
}

function writeFile600(ctx: MigrationCtx, path: string, content: string): void {
  if (ctx.dryRun) { ctx.log(`[dry-run] write ${rel(ctx, path)}`); return; }
  writeFileSync(path, content);
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

function seedPerImageTagVars(ctx: MigrationCtx): void {
  const envPath = stackEnvFile(ctx.stashDir);
  if (!existsSync(envPath)) return;

  const current = readFileSync(envPath, 'utf-8');
  const imageTagMatch = current.match(/^OP_IMAGE_TAG=(.+)$/m);
  const imageTag = imageTagMatch?.[1]?.trim();
  if (!imageTag) return;

  const missingKeys = PLATFORM_IMAGE_TAG_KEYS.filter((key) => !new RegExp(`^${key}=`, 'm').test(current));
  if (missingKeys.length === 0) return;

  if (ctx.dryRun) {
    ctx.log(`[dry-run] seed per-image tag vars from OP_IMAGE_TAG=${imageTag}`);
    return;
  }

  let next = upsertMany(current, buildPlatformImageTagEnv(imageTag));
  const legacyPortalTag = readStackEnvValue(ctx.stashDir, 'OP_CHANNEL_IMAGE_TAG');
  if (legacyPortalTag && !/^OP_PORTAL_IMAGE_TAG=/m.test(next)) {
    next = upsertEnvValue(next, 'OP_PORTAL_IMAGE_TAG', legacyPortalTag);
  }
  writeFile600(ctx, envPath, next);
  ctx.log(`seeded per-image tag vars from OP_IMAGE_TAG=${imageTag}`);
}

// ── Release migration v0.12.0: copy non-sensitive addon config from secret files → stack.env ─

/**
 * Keys that are sensitive and must stay as compose secret files.
 * Matches the @sensitive annotation in BUILTIN_ADDON_ENV_SCHEMAS.
 */
const ADDON_SENSITIVE_KEY_RE = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;

/**
 * Non-sensitive addon config keys that pre-C4 code wrote to knowledge/secrets/.
 * These should live in stack.env so they are visible to `docker compose config`.
 * The key filename in secrets/ is the lowercase key name; we read it and copy to
 * stack.env only if the key is not already present there.
 * Source files are NEVER deleted (user data).
 */
function migrateAddonConfigToStackEnv(ctx: MigrationCtx): void {
  const envPath = stackEnvFile(ctx.stashDir);
  if (!existsSync(envPath)) return;

  const secretsDir = join(ctx.homeDir, 'knowledge', 'secrets');
  if (!existsSync(secretsDir)) return;

  const stackContent = readFileSync(envPath, 'utf-8');
  const additions: Record<string, string> = {};
  // ALLOWLIST: only ever promote KNOWN, declared, non-sensitive addon-config keys.
  // knowledge/secrets/ is a GENERAL secret store (ssh keys, github/OAuth creds, akm
  // secrets, per-portal verification secrets) — copying a file into the non-secret
  // stack.env merely because its name lacks a `_TOKEN/_SECRET/...` suffix would leak
  // credentials. The suffix check below is now just belt-and-suspenders.
  const allowedKeys = nonSensitiveAddonEnvKeys();

  for (const filename of readdirSync(secretsDir)) {
    // Only process simple env-key files (no dots, no sub-paths).
    if (filename.includes('.') || filename.includes('/')) continue;

    const envKey = filename.toUpperCase();
    // Only promote a file whose key is a declared non-sensitive addon-config key.
    if (!allowedKeys.has(envKey)) continue;
    // Defense in depth: skip anything that still looks sensitive by suffix.
    if (ADDON_SENSITIVE_KEY_RE.test(envKey)) continue;
    // Skip if already present in stack.env.
    if (new RegExp(`^${envKey}=`, 'm').test(stackContent)) {
      ctx.log(`skip (exists in stack.env): ${envKey}`);
      continue;
    }

    const filePath = join(secretsDir, filename);
    try {
      const value = readFileSync(filePath, 'utf-8').replace(/[\r\n]+$/, '');
      if (value.length === 0) continue; // skip empty values
      additions[envKey] = value;
      ctx.log(`copy non-sensitive addon config: knowledge/secrets/${filename} -> stack.env ${envKey}`);
    } catch {
      ctx.log(`skip (unreadable): knowledge/secrets/${filename}`);
    }
  }

  if (Object.keys(additions).length === 0) return;

  if (ctx.dryRun) {
    ctx.log(`[dry-run] would add ${Object.keys(additions).length} non-sensitive key(s) to stack.env`);
    return;
  }

  let next = stackContent;
  for (const [key, value] of Object.entries(additions)) {
    next = upsertEnvValue(next, key, value);
  }
  writeFile600(ctx, envPath, next);
}

/**
 * Portal rename (0.12.0): the "channels" concept became "portals". The
 * materialized compose file moved channels.compose.yml → portals.compose.yml
 * (re-seeded by the normal asset refresh) and the per-portal verification
 * secrets moved channel_<name>_secret → portal_<name>_secret. The new
 * portals.compose.yml references `portal_<name>_secret` files, so existing
 * installs whose secrets are still named `channel_<name>_secret` would fail
 * Compose's secret `file:` lookup. Rename each to its portal_-named sibling
 * (the value is preserved — a rename loses no data; skip if the portal_ name
 * already exists). The stale channels.compose.yml is inert because
 * discoverStackOverlays() loads an explicit name list, not a glob.
 */
function migratePortalSecretNames(ctx: MigrationCtx): void {
  const secretsDir = join(ctx.homeDir, 'knowledge', 'secrets');
  if (!existsSync(secretsDir)) return;

  for (const filename of readdirSync(secretsDir)) {
    const m = filename.match(/^channel_(.+)_secret$/);
    if (!m) continue;
    const dest = join(secretsDir, `portal_${m[1]}_secret`);
    if (existsSync(dest)) { ctx.log(`skip (exists): knowledge/secrets/portal_${m[1]}_secret`); continue; }
    if (ctx.dryRun) {
      ctx.log(`[dry-run] rename secret: channel_${m[1]}_secret -> portal_${m[1]}_secret`);
      continue;
    }
    renameSync(join(secretsDir, filename), dest);
    try { chmodSync(dest, 0o600); } catch { /* best-effort */ }
    ctx.log(`portal secret: channel_${m[1]}_secret -> portal_${m[1]}_secret`);
  }
}

/**
 * Portal rename (0.12.0) — user custom overlay network reference.
 * A user-authored config/stack/custom.compose.yml may reference the `channel_lan`
 * network, which was renamed to `portal_net` in 0.12.0. `channel_lan` survives as
 * a deprecated empty bridge for this one release but is REMOVED in 0.13.0 — at
 * which point an overlay still referencing it fails Compose validation. Rewrite
 * `channel_lan` → `portal_net` in the user's overlay so it keeps working past
 * 0.13.0 with no manual step.
 *
 * Non-destructive: the original is copied to custom.compose.yml.pre-portal-rename.bak
 * first (skip if that backup already exists), and the rewrite is idempotent (a
 * second run finds no `channel_lan` token and does nothing). The token is specific
 * enough that a word-boundary replace is safe; the rare case of an overlay that
 * *defines* its own external `channel_lan` network is covered by the .bak copy.
 */
function migrateCustomComposeChannelLan(ctx: MigrationCtx): void {
  const customPath = join(ctx.stackDir, 'custom.compose.yml');
  if (!existsSync(customPath)) return;

  let content: string;
  try {
    content = readFileSync(customPath, 'utf-8');
  } catch {
    ctx.log('skip (unreadable): config/stack/custom.compose.yml');
    return;
  }

  if (!/\bchannel_lan\b/.test(content)) return; // idempotent: nothing to migrate

  const next = content.replace(/\bchannel_lan\b/g, 'portal_net');
  if (next === content) return;

  if (ctx.dryRun) {
    ctx.log('[dry-run] rewrite channel_lan -> portal_net in config/stack/custom.compose.yml');
    return;
  }

  // Back up the user's original overlay before editing (skip if a backup exists).
  const backupPath = `${customPath}.pre-portal-rename.bak`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, content);
    try { chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
    ctx.log('backed up config/stack/custom.compose.yml -> custom.compose.yml.pre-portal-rename.bak');
  }

  writeFileSync(customPath, next);
  ctx.log('rewrote channel_lan -> portal_net in config/stack/custom.compose.yml');
  ctx.notes.push(
    'Your config/stack/custom.compose.yml referenced the deprecated `channel_lan` network; it was rewritten to `portal_net` (the original was saved as custom.compose.yml.pre-portal-rename.bak). `channel_lan` is removed in 0.13.0.',
  );
}

// ── Migration 0 → 1: 0.10.x `vault/` layout → 0.11.0 knowledge/ layout ────────

const SECRET_KEY_RE = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/;
const CONFIG_KEY_RE = /^(OP_CAP_|SYSTEM_LLM_|EMBEDDING_)/;

function migrate010to011(ctx: MigrationCtx): void {
  const vault = join(ctx.homeDir, "vault");
  const newEnv = join(ctx.stashDir, "env");
  const newSecrets = join(ctx.stashDir, "secrets");
  ensureDir(ctx, newEnv);
  ensureDir(ctx, newSecrets);

  // user.env → knowledge/env/user.env
  copyIfAbsent(ctx, join(vault, "user", "user.env"), join(newEnv, "user.env"));

  // stack.env transform → knowledge/env/stack.env
  const srcStack = join(vault, "stack", "stack.env");
  const destStack = join(newEnv, "stack.env");
  if (existsSync(srcStack) && !existsSync(destStack)) {
    const kept: string[] = [];
    const removed: string[] = [];
    for (const line of readFileSync(srcStack, "utf-8").split("\n")) {
      if (line === "" || line.startsWith("#")) { kept.push(line); continue; }
      const eq = line.indexOf("=");
      const key = eq >= 0 ? line.slice(0, eq) : line;
      const val = eq >= 0 ? line.slice(eq + 1) : "";
      if (key === "OP_UI_LOGIN_PASSWORD") {
        writeFile600(ctx, join(newSecrets, "op_ui_login_password"), val + "\n");
        ctx.log("extracted OP_UI_LOGIN_PASSWORD -> knowledge/secrets/op_ui_login_password");
      } else if (key === "OP_ADMIN_PORT") {
        kept.push(`OP_HOST_UI_PORT=${val}`);
        ctx.log("renamed OP_ADMIN_PORT -> OP_HOST_UI_PORT");
      } else if (key === "OP_ADMIN_OPENCODE_PORT" || key === "OP_GUARDIAN_PORT") {
        ctx.log(`dropped removed var: ${key}`);
      } else if (key.startsWith("TTS_") || key.startsWith("STT_")) {
        kept.push(`OP_${key}=${val}`);
        ctx.log(`renamed ${key} -> OP_${key}`);
      } else if (CONFIG_KEY_RE.test(key) || SECRET_KEY_RE.test(key)) {
        removed.push(line);
        ctx.log(`quarantined: ${key}`);
      } else {
        kept.push(line);
      }
    }
    writeFile600(ctx, destStack, kept.join("\n") + "\n");
    if (removed.length > 0) {
      writeFile600(ctx, join(newEnv, "stack.env.removed-secrets.bak"), removed.join("\n") + "\n");
      ctx.notes.push(
        "Secret/capability keys were removed from stack.env (saved to knowledge/env/stack.env.removed-secrets.bak) — re-enter provider keys via the Connections tab and LLM config via config/akm/config.json; do not put them back in stack.env.",
      );
    }
  }

  // provider creds (best-effort) + service secrets
  if (copyIfAbsent(ctx, join(vault, "stack", "auth.json"), join(newSecrets, "auth.json"))) {
    ctx.notes.push("Copied auth.json best-effort — verify providers in the Connections tab and re-add any that are missing (the OpenCode auth format changed).");
  }
  const servicesDir = join(vault, "stack", "services");
  if (existsSync(servicesDir)) {
    for (const name of readdirSync(servicesDir)) {
      copyIfAbsent(ctx, join(servicesDir, name), join(newSecrets, name));
    }
  }

  // channel HMAC secrets: split CHANNEL_<NAME>_SECRET into per-secret files
  const guardianEnv = join(vault, "stack", "guardian.env");
  if (existsSync(guardianEnv)) {
    for (const line of readFileSync(guardianEnv, "utf-8").split("\n")) {
      const m = line.match(/^CHANNEL_(.+)_SECRET=(.*)$/);
      if (!m) continue;
      const name = m[1].toLowerCase();
      if (!ADDON_NAME_RE.test(name)) continue;
      const dest = join(newSecrets, `channel_${name}_secret`);
      if (existsSync(dest)) { ctx.log(`skip (exists): knowledge/secrets/channel_${name}_secret`); continue; }
      writeFile600(ctx, dest, m[2] + "\n");
      ctx.log(`channel secret: ${m[1]} -> knowledge/secrets/channel_${name}_secret`);
    }
  }

  // user credential files mounted into the assistant at /etc/openpalm
  for (const n of ["apprise.yaml", "apprise.conf", "gcloud-credentials.json"]) {
    copyIfAbsent(ctx, join(vault, "user", n), join(newSecrets, n));
  }
  for (const d of [".gws", ".gcloud", ".mgc"]) {
    copyIfAbsent(ctx, join(vault, "user", d), join(newSecrets, d));
  }

  // Leave a README in the retained legacy vault/ explaining that it is now a
  // recovery copy and how to remove it safely once 0.11.x is confirmed working.
  writeVaultReadme(ctx, vault);

  // Addon enablement: stack.yml is removed in 0.11.0. Convert any addons[] from
  // a legacy stack.yml (config/stack.yml or config/stack/stack.yml) into
  // OP_ENABLED_ADDONS in stack.env. Do NOT create stack.yml.
  const addons = readLegacyStackYmlAddons(ctx);
  if (addons.length > 0) {
    const envPath = stackEnvFile(ctx.stashDir);
    if (ctx.dryRun) {
      ctx.log(`[dry-run] set OP_ENABLED_ADDONS=${addons.join(",")}`);
    } else if (existsSync(envPath)) {
      writeFile600(ctx, envPath, upsertEnvValue(readFileSync(envPath, "utf-8"), "OP_ENABLED_ADDONS", addons.join(",")));
      ctx.log(`set OP_ENABLED_ADDONS=${addons.join(",")}`);
    }
  }
}

const VAULT_README = `# This \`vault/\` directory is from OpenPalm 0.10.x — it is now a RECOVERY COPY

OpenPalm 0.11.0 changed the on-disk layout. The upgrade **copied** everything out
of this \`vault/\` directory into the new locations and left these originals here,
untouched, as a safety net:

- \`vault/user/user.env\`        → \`knowledge/env/user.env\`
- \`vault/stack/stack.env\`       → \`knowledge/env/stack.env\` (transformed)
- \`vault/stack/guardian.env\`    → \`knowledge/secrets/channel_<name>_secret\`
- \`vault/stack/services/*\`      → \`knowledge/secrets/\`
- \`vault/stack/auth.json\`       → \`knowledge/secrets/auth.json\` (best-effort)
- other user credential files   → \`knowledge/secrets/\`

A full backup of your home was also taken under \`data/backups/\` before migrating.

Nothing in 0.11.x reads this directory anymore. You can delete it once you have
confirmed the new version works.

## How to remove it safely

1. Confirm 0.11.x is healthy: the stack starts (\`openpalm status\`), you can sign
   in to the UI, your providers are connected (Connections tab), and your
   channels still work.
2. Spot-check that your data is in the new layout:
   - \`knowledge/env/stack.env\` and \`knowledge/env/user.env\` look right
   - your secrets are under \`knowledge/secrets/\` (login password, channel
     secrets, \`auth.json\`, etc.)
   - if \`knowledge/env/stack.env.removed-secrets.bak\` exists, re-enter those
     provider keys (Connections) and LLM config (\`config/akm/config.json\`) — do
     not put secrets back into \`stack.env\`.
3. Only then remove this directory. Prefer your OS trash (reversible):
   - Linux:   \`gio trash ~/.openpalm/vault\`  (or \`trash-put ~/.openpalm/vault\`)
   - macOS:   \`trash ~/.openpalm/vault\`
   - Windows: delete \`%USERPROFILE%\\.openpalm\\vault\` (sends to Recycle Bin)
   - Last resort (irreversible): \`rm -rf ~/.openpalm/vault\`

If anything looks wrong, do NOT delete this directory — restore from it or from
\`data/backups/\`. Full guide: docs/operations/upgrade-0.10-to-0.11.md
`;

/** Drop a safe-removal README into the retained legacy vault/ (skip if present). */
function writeVaultReadme(ctx: MigrationCtx, vault: string): void {
  const dest = join(vault, "README.md");
  if (existsSync(dest)) { ctx.log("skip (exists): vault/README.md"); return; }
  if (ctx.dryRun) { ctx.log("[dry-run] write vault/README.md (safe-removal guide)"); return; }
  writeFileSync(dest, VAULT_README);
  ctx.log("wrote vault/README.md (safe-removal guide)");
}

/** Extract a validated addons[] list from any legacy stack.yml, or []. */
function readLegacyStackYmlAddons(ctx: MigrationCtx): string[] {
  for (const p of [join(ctx.configDir, "stack.yml"), join(ctx.stackDir, "stack.yml")]) {
    if (!existsSync(p)) continue;
    try {
      const raw = yamlParse(readFileSync(p, "utf-8")) as { addons?: unknown };
      if (Array.isArray(raw?.addons)) {
        return [...new Set(raw.addons.filter((v): v is string => typeof v === "string" && ADDON_NAME_RE.test(v)))].sort();
      }
    } catch { /* ignore unparseable */ }
  }
  return [];
}

// ── Migration 1 → 2: drop inert pre-0.12.0 SYSTEM files ───────────────────────

/**
 * SYSTEM-managed files the 0.12.0 control plane no longer materializes or reads.
 * Removed so OP_HOME holds only the current managed asset set. This is an explicit
 * ALLOWLIST of system files — NEVER user data, NEVER a heuristic sweep:
 *   - config/stack/channels.compose.yml — renamed to portals.compose.yml in 0.12.0;
 *     the control plane loads an explicit overlay list (not a glob), so it is inert.
 *   - config/stack/stack.yml — the StackSpec was removed in 0.11.0 (addons live in
 *     OP_ENABLED_ADDONS; the 0→1 migration already extracts any legacy addons[]).
 * Removal is safe because the layout-migration path takes a FULL OP_HOME backup
 * first and aborts if it fails (see ensureMigrated), so a stamped layout bump is
 * always recoverable. User data is never removed; if a future inert path actually
 * holds user data it must be MOVED to its proper location here, not deleted.
 */
const INERT_LAYOUT_V2_FILES: string[] = [
  join("config", "stack", "channels.compose.yml"),
  join("config", "stack", "stack.yml"),
];

function migrate1to2(ctx: MigrationCtx): void {
  for (const rel of INERT_LAYOUT_V2_FILES) {
    const full = join(ctx.homeDir, rel);
    if (!existsSync(full)) continue;
    if (ctx.dryRun) { ctx.log(`[dry-run] remove inert system file: ${rel}`); continue; }
    rmSync(full, { force: true });
    ctx.log(`removed inert pre-0.12.0 system file: ${rel}`);
  }
}

const MIGRATIONS: Migration[] = [
  {
    from: 0,
    to: 1,
    describe: "0.10.x vault/ layout → 0.11.0 knowledge/ layout",
    apply: migrate010to011,
    verify(ctx) {
      // The migration must have produced a usable 0.11 stack.env (unless a
      // dry-run, where nothing was written).
      if (ctx.dryRun) return;
      if (!existsSync(stackEnvFile(ctx.stashDir))) {
        throw new Error("post-migration check failed: knowledge/env/stack.env is missing");
      }
    },
  },
  {
    from: 1,
    to: 2,
    describe: "drop inert pre-0.12.0 system files (channels.compose.yml, stack.yml)",
    apply: migrate1to2,
    verify(ctx) {
      // Backup-first removal (the layout path backed up the whole home); the inert
      // system files must be gone after a real run.
      if (ctx.dryRun) return;
      for (const rel of INERT_LAYOUT_V2_FILES) {
        if (existsSync(join(ctx.homeDir, rel))) {
          throw new Error(`post-migration check failed: inert ${rel} still present`);
        }
      }
    },
  },
];

const RELEASE_MIGRATIONS: ReleaseMigration[] = [
  {
    // Pinned to the release that INTRODUCED per-image tags, not the lib
    // version: tying it to CURRENT_RELEASE_VERSION would re-select the
    // migration on every future release whose stamp predates the running lib.
    // Every release migration must also be idempotent — it may run again on
    // installs whose OP_RELEASE_VERSION was never stamped.
    version: 'v0.11.5-rc.1',
    describe: 'seed per-image platform tags from OP_IMAGE_TAG',
    apply: seedPerImageTagVars,
    verify(ctx) {
      if (ctx.dryRun) return;
      const envPath = stackEnvFile(ctx.stashDir);
      if (!existsSync(envPath)) return;
      const content = readFileSync(envPath, 'utf-8');
      if (!/^OP_IMAGE_TAG=/m.test(content)) return;
      for (const key of PLATFORM_IMAGE_TAG_KEYS) {
        if (!new RegExp(`^${key}=`, 'm').test(content)) {
          throw new Error(`post-migration check failed: ${key} is missing`);
        }
      }
    },
  },
  {
    // Pinned to v0.12.0: the C4 slice moved non-sensitive addon config from
    // knowledge/secrets/<KEY> files into stack.env. This migration copies any
    // pre-existing non-sensitive secret files into stack.env (skip-if-present,
    // never delete the source — source files are user data).
    version: 'v0.12.0-rc.1',
    describe: 'copy non-sensitive addon config from knowledge/secrets/ into stack.env',
    apply: migrateAddonConfigToStackEnv,
    verify(ctx) {
      // Nothing to assert here beyond what apply() logs — it is copy-only and
      // idempotent; a dry-run pass suffices.
    },
  },
  {
    // 0.12.0 channels → portals rename: per-portal verification secrets moved
    // channel_<name>_secret → portal_<name>_secret (portals.compose.yml now
    // references the portal_-named files). Copy-only + idempotent.
    version: 'v0.12.0-rc.1',
    describe: 'copy per-portal verification secrets channel_<name>_secret -> portal_<name>_secret',
    apply: migratePortalSecretNames,
    verify(ctx) {
      // Copy-only + skip-if-present; apply()'s logs suffice.
    },
  },
  {
    // 0.12.0 channels → portals rename: a user-authored custom.compose.yml may
    // still reference the `channel_lan` network (renamed to `portal_net`).
    // Rewrite it so the overlay keeps validating after channel_lan is removed in
    // 0.13.0. Backup-first + idempotent (skip when no channel_lan token remains).
    version: 'v0.12.0-rc.1',
    describe: 'rewrite channel_lan -> portal_net in user custom.compose.yml overlay',
    apply: migrateCustomComposeChannelLan,
    verify(ctx) {
      // Backup-first + idempotent token rewrite; apply()'s logs suffice.
    },
  },
];

// ── Public entry point ────────────────────────────────────────────────────────

const RECOVERY_GUIDANCE =
  "Your original files were left untouched and a full backup was taken first. " +
  "If something went wrong, run `openpalm rollback` to restore your previous state, " +
  "or restore the backup manually (see docs/operations/backup-restore.md). You can also run " +
  "`openpalm migrate --dry-run` to preview the current copy-only migration. " +
  "Full guide: docs/operations/upgrade-0.10-to-0.11.md";

function resolveComparableReleaseTarget(rawVersion: string | null): string | null {
  if (!rawVersion) return null;
  return isComparableSemver(rawVersion) ? rawVersion : null;
}

function logSkippedNonComparableReleaseStamp(
  log: (m: string) => void,
  notes: string[],
  requestedVersion: string,
): void {
  const note = `Skipped OP_RELEASE_VERSION stamp for non-comparable deployed tag \"${requestedVersion}\".`;
  log(JSON.stringify({ event: 'release-version-stamp-skipped', requestedVersion, reason: 'non-comparable-tag' }));
  notes.push(note);
}

function runReleaseMigrations(
  ctxBase: MigrationCtx,
  releaseFrom: string | null,
  targetVersion: string | null,
): { applied: string[] } {
  const comparableTarget = resolveComparableReleaseTarget(targetVersion);
  if (!comparableTarget) return { applied: [] };

  const applied: string[] = [];
  for (const migration of selectPendingReleaseMigrations(releaseFrom, comparableTarget)) {
    const ctx: MigrationCtx = { ...ctxBase, notes: ctxBase.notes };
    ctx.log(`Migrating release ${releaseFrom ?? 'unknown'} → ${migration.version}: ${migration.describe}`);
    migration.apply(ctx);
    migration.verify(ctx);
    applied.push(migration.version);
  }

  return { applied };
}

/**
 * Ensure the home directory is migrated to the current layout. Safe to call at
 * the top of any upgrade/install entry point. Resolves its own paths (must run
 * before createState, which assumes the current layout).
 */
export function ensureMigrated(opts: { homeDir?: string; dryRun?: boolean; confirmLowSpace?: boolean; log?: (m: string) => void } = {}): MigrationReport {
  const homeDir = opts.homeDir
    ? resolvePath(opts.homeDir)
    : process.env.OP_HOME
      ? resolvePath(process.env.OP_HOME)
      : resolvePath(process.env.HOME ?? '', '.openpalm');
  const dryRun = opts.dryRun ?? false;
  const confirmLowSpace = opts.confirmLowSpace ?? false;
  const log = opts.log ?? (() => {});
  const ctxBase = {
    ...resolveMigrationPaths(homeDir),
    dryRun,
    log,
    notes: [] as string[],
  };

  const from = readLayoutVersion(ctxBase);
  const releaseFrom = readReleaseVersion(ctxBase.stashDir);
  const releaseStamp = readStampedReleaseVersion(ctxBase.stashDir);
  const layoutStamp = readStampedLayoutVersion(ctxBase.stashDir);
  const releaseTargetRaw = releaseStamp ?? readImageTag(ctxBase.stashDir);
  const comparableReleaseTarget = resolveComparableReleaseTarget(releaseTargetRaw);
  const needsLayoutStamp = layoutStamp !== CURRENT_LAYOUT_VERSION;
  const needsReleaseStamp = comparableReleaseTarget !== null && releaseStamp !== comparableReleaseTarget;
  const empty: MigrationReport = {
    migrated: false,
    from,
    to: from,
    applied: [],
    backupDir: null,
    notes: [],
    releaseFrom,
    releaseTo: comparableReleaseTarget ?? releaseFrom ?? '',
    releaseApplied: [],
  };

  // Upper-bound on the SOURCE version: a migration whose `from` is below the
  // current layout ceiling must run. Bounding on `m.to` instead would silently
  // drop a newly added migration if CURRENT_LAYOUT_VERSION lagged behind it.
  const pending = MIGRATIONS
    .filter((m) => m.from >= from && m.from < CURRENT_LAYOUT_VERSION)
    .sort((a, b) => a.from - b.from);
  const pendingRelease = comparableReleaseTarget ? selectPendingReleaseMigrations(releaseFrom, comparableReleaseTarget) : [];
  if (pending.length === 0 && pendingRelease.length === 0 && !needsLayoutStamp && !needsReleaseStamp) {
    return { ...empty, to: CURRENT_LAYOUT_VERSION };
  }

  let lock: ReturnType<typeof acquireInstallLock> = null;
  let backupDir: string | null = null;
  try {
    // Mutual exclusion + backup gate: never migrate without a verified safety
    // copy. Any failure here aborts with no changes made.
    if (!dryRun) {
      try {
        mkdirSync(ctxBase.dataDir, { recursive: true });
      } catch (e) {
        throw new MigrationError(`Could not prepare the data directory: ${e instanceof Error ? e.message : String(e)}`, RECOVERY_GUIDANCE, null);
      }
      lock = acquireInstallLock(ctxBase.dataDir);
      if (!lock) {
        throw new MigrationError("Another install/upgrade is in progress.", RECOVERY_GUIDANCE, null);
      }
      // Pre-backup free-space guard: a full-home copy includes data/ (AKM dbs,
      // logs, caches) and can be gigabytes. Refuse to silently fill the disk —
      // require explicit confirmation when the estimate exceeds the safe
      // fraction of free space. This never deletes anything (owner-forbidden).
      const spaceCheck = checkBackupFreeSpace(homeDir);
      if (spaceCheck.insufficient && !confirmLowSpace) {
        throw new BackupSpaceError(
          describeBackupSpaceShortfall(spaceCheck),
          RECOVERY_GUIDANCE,
          spaceCheck.estimatedBytes,
          spaceCheck.freeBytes,
        );
      }
      log("Taking a full backup before migrating…");
      try {
        backupDir = backupOpenPalmHome(homeDir);
      } catch (e) {
        throw new MigrationError(`Could not create a safety backup; upgrade aborted (no changes made): ${e instanceof Error ? e.message : String(e)}`, RECOVERY_GUIDANCE, null);
      }
      if (!backupDir) {
        throw new MigrationError("Could not create a safety backup; upgrade aborted (no changes made).", RECOVERY_GUIDANCE, null);
      }
      log(`Backup: ${backupDir}`);
    }

    const applied: string[] = [];
    const notes: string[] = [];
    for (const m of pending) {
      const ctx: MigrationCtx = { ...ctxBase, notes };
      log(`Migrating layout ${m.from} → ${m.to}: ${m.describe}`);
      m.apply(ctx);
      m.verify(ctx);
      applied.push(`${m.from}->${m.to}`);
    }

    const { applied: releaseApplied } = runReleaseMigrations({ ...ctxBase, notes }, releaseFrom, releaseTargetRaw);

    if (!dryRun && releaseTargetRaw && comparableReleaseTarget === null) {
      logSkippedNonComparableReleaseStamp(log, notes, releaseTargetRaw);
    }

    // Commit point: bump the version markers LAST.
    if (!dryRun) {
      stampLayoutVersion(ctxBase.stashDir, CURRENT_LAYOUT_VERSION);
      if (comparableReleaseTarget) {
        stampReleaseVersion(ctxBase.stashDir, comparableReleaseTarget);
      }
    }

    return {
      migrated: true,
      from,
      to: CURRENT_LAYOUT_VERSION,
      applied,
      backupDir,
      notes,
      releaseFrom,
      releaseTo: comparableReleaseTarget ?? releaseFrom ?? '',
      releaseApplied,
    };
  } catch (e) {
    if (e instanceof MigrationError) throw e;
    throw new MigrationError(
      `Migration failed: ${e instanceof Error ? e.message : String(e)}`,
      RECOVERY_GUIDANCE,
      backupDir,
    );
  } finally {
    releaseInstallLock(lock);
  }
}

export function ensureReleaseMigrated(
  opts: { homeDir?: string; targetVersion: string; dryRun?: boolean; log?: (m: string) => void },
): ReleaseMigrationReport {
  const homeDir = opts.homeDir
    ? resolvePath(opts.homeDir)
    : process.env.OP_HOME
      ? resolvePath(process.env.OP_HOME)
      : resolvePath(process.env.HOME ?? '', '.openpalm');
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? (() => {});
  const paths = resolveMigrationPaths(homeDir);
  const targetVersion = opts.targetVersion.trim();
  const comparableTarget = resolveComparableReleaseTarget(targetVersion);
  const releaseFrom = readReleaseVersion(paths.stashDir);
  const releaseStamp = readStampedReleaseVersion(paths.stashDir);
  const pendingRelease = comparableTarget ? selectPendingReleaseMigrations(releaseFrom, comparableTarget) : [];
  const empty: ReleaseMigrationReport = {
    migrated: false,
    from: releaseFrom,
    to: targetVersion,
    applied: [],
    backupDir: null,
    notes: [],
  };

  if (comparableTarget === null) {
    const notes: string[] = [];
    if (!dryRun) {
      logSkippedNonComparableReleaseStamp(log, notes, targetVersion);
    }
    return { ...empty, notes };
  }

  if (pendingRelease.length === 0 && releaseStamp === comparableTarget) {
    return empty;
  }

  const ctxBase: MigrationCtx = {
    ...paths,
    dryRun,
    log,
    notes: [] as string[],
  };

  let lock: ReturnType<typeof acquireInstallLock> = null;
  let backupDir: string | null = null;
  try {
    if (!dryRun) {
      try {
        mkdirSync(ctxBase.dataDir, { recursive: true });
      } catch (e) {
        throw new MigrationError(`Could not prepare the data directory: ${e instanceof Error ? e.message : String(e)}`, RECOVERY_GUIDANCE, null);
      }
      lock = acquireInstallLock(ctxBase.dataDir);
      if (!lock) {
        throw new MigrationError('Another install/upgrade is in progress.', RECOVERY_GUIDANCE, null);
      }
      // Release migrations only edit knowledge/env/stack.env, so back up just
      // that file — a full OP_HOME copy (data/ can be gigabytes) is the layout
      // migration's job, not warranted for an env-file append.
      const envPath = stackEnvFile(paths.stashDir);
      if (existsSync(envPath)) {
        log('Backing up stack.env before migrating…');
        try {
          backupDir = join(ctxBase.dataDir, 'backups', `${timestampDirName()}-release`);
          mkdirSync(backupDir, { recursive: true });
          copyFileSync(envPath, join(backupDir, 'stack.env'));
        } catch (e) {
          throw new MigrationError(`Could not create a safety backup; upgrade aborted (no changes made): ${e instanceof Error ? e.message : String(e)}`, RECOVERY_GUIDANCE, null);
        }
        log(`Backup: ${backupDir}`);
      }
    }

    const notes: string[] = [];
    const { applied } = runReleaseMigrations({ ...ctxBase, notes }, releaseFrom, targetVersion);

    if (!dryRun && comparableTarget) {
      stampReleaseVersion(paths.stashDir, comparableTarget);
    }

    return {
      migrated: true,
      from: releaseFrom,
      to: targetVersion,
      applied,
      backupDir,
      notes,
    };
  } catch (e) {
    if (e instanceof MigrationError) throw e;
    throw new MigrationError(
      `Migration failed: ${e instanceof Error ? e.message : String(e)}`,
      RECOVERY_GUIDANCE,
      backupDir,
    );
  } finally {
    releaseInstallLock(lock);
  }
}
