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
 *   - Migrations are COPY-ONLY / additive (never delete the old layout), so a
 *     mid-run failure leaves the home fully recoverable.
 *   - The OP_LAYOUT_VERSION bump is the LAST step (the commit point); a crash
 *     before it just re-runs next time (idempotent).
 *   - On failure, throw MigrationError carrying the backup path + recovery
 *     guidance for the CLI/UI to surface.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, statSync, chmodSync, cpSync,
} from "node:fs";
import libPkg from '../../package.json' with { type: 'json' };
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import {
  resolveOpenPalmHome, resolveDataDir, resolveStackDir, resolveStashDir, resolveConfigDir,
} from "./home.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import { backupOpenPalmHome } from "./backup.js";
import { upsertEnvValue } from "./env.js";
import { PLATFORM_IMAGE_TAG_KEYS, buildPlatformImageTagEnv } from './image-tags.js';
import { compareComparableVersions, isComparableSemver } from './versioning.js';

export const LAYOUT_VERSION_KEY = "OP_LAYOUT_VERSION";
/** Bump when the on-disk layout changes and add a Migration to MIGRATIONS. */
export const CURRENT_LAYOUT_VERSION = 1;

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
const CURRENT_RELEASE_VERSION = `v${libPkg.version}`;

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

function stampLayoutVersion(stashDir: string, version: number): void {
  const envPath = stackEnvFile(stashDir);
  if (!existsSync(envPath)) return; // nothing to stamp; not a usable install
  const next = upsertEnvValue(readFileSync(envPath, "utf-8"), LAYOUT_VERSION_KEY, String(version));
  writeFileSync(envPath, next);
}

function readReleaseVersion(stashDir: string): string | null {
  const envPath = stackEnvFile(stashDir);
  if (!existsSync(envPath)) return null;

  let imageTagFallback: string | null = null;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const releaseMatch = line.match(/^OP_RELEASE_VERSION=(.+)\s*$/);
    if (releaseMatch) return releaseMatch[1].trim();

    const imageTagMatch = line.match(/^OP_IMAGE_TAG=(.+)\s*$/);
    if (imageTagMatch && !imageTagFallback) imageTagFallback = imageTagMatch[1].trim();
  }

  return imageTagFallback;
}

function stampReleaseVersion(stashDir: string, version: string): void {
  const envPath = stackEnvFile(stashDir);
  if (!existsSync(envPath)) return;
  const next = upsertEnvValue(readFileSync(envPath, 'utf-8'), RELEASE_VERSION_KEY, version);
  writeFileSync(envPath, next);
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

  writeFile600(ctx, envPath, upsertMany(current, buildPlatformImageTagEnv(imageTag)));
  ctx.log(`seeded per-image tag vars from OP_IMAGE_TAG=${imageTag}`);
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
];

const RELEASE_MIGRATIONS: ReleaseMigration[] = [
  {
    version: CURRENT_RELEASE_VERSION,
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
];

// ── Public entry point ────────────────────────────────────────────────────────

const RECOVERY_GUIDANCE =
  "Your original files were left untouched and a full backup was taken first. " +
  "To recover, restore the backup (see docs/operations/backup-restore.md) or run " +
  "the standalone migrator with --dry-run (scripts/migrate-0.10-to-0.11.sh / .ps1). " +
  "Full guide: docs/operations/upgrade-0.10-to-0.11.md";

/**
 * Ensure the home directory is migrated to the current layout. Safe to call at
 * the top of any upgrade/install entry point. Resolves its own paths (must run
 * before createState, which assumes the current layout).
 */
export function ensureMigrated(opts: { homeDir?: string; dryRun?: boolean; log?: (m: string) => void } = {}): MigrationReport {
  const homeDir = opts.homeDir ?? resolveOpenPalmHome();
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? (() => {});
  const stashDir = resolveStashDir();
  const ctxBase = {
    homeDir,
    dataDir: resolveDataDir(),
    stackDir: resolveStackDir(),
    stashDir,
    configDir: resolveConfigDir(),
    dryRun,
    log,
    notes: [] as string[],
  };

  const from = readLayoutVersion(ctxBase);
  const releaseFrom = readReleaseVersion(stashDir);
  const empty: MigrationReport = {
    migrated: false,
    from,
    to: from,
    applied: [],
    backupDir: null,
    notes: [],
    releaseFrom,
    releaseTo: CURRENT_RELEASE_VERSION,
    releaseApplied: [],
  };

  const pending = MIGRATIONS
    .filter((m) => m.from >= from && m.to <= CURRENT_LAYOUT_VERSION)
    .sort((a, b) => a.from - b.from);
  const pendingRelease = selectPendingReleaseMigrations(releaseFrom, CURRENT_RELEASE_VERSION);
  if (pending.length === 0 && pendingRelease.length === 0) {
    if (!dryRun) {
      stampLayoutVersion(stashDir, CURRENT_LAYOUT_VERSION);
      stampReleaseVersion(stashDir, CURRENT_RELEASE_VERSION);
    }
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
    const releaseApplied: string[] = [];
    const notes: string[] = [];
    for (const m of pending) {
      const ctx: MigrationCtx = { ...ctxBase, notes };
      log(`Migrating layout ${m.from} → ${m.to}: ${m.describe}`);
      m.apply(ctx);
      m.verify(ctx);
      applied.push(`${m.from}->${m.to}`);
    }

    for (const migration of pendingRelease) {
      const ctx: MigrationCtx = { ...ctxBase, notes };
      log(`Migrating release ${releaseFrom ?? 'unknown'} → ${migration.version}: ${migration.describe}`);
      migration.apply(ctx);
      migration.verify(ctx);
      releaseApplied.push(migration.version);
    }

    // Commit point: bump the version markers LAST.
    if (!dryRun) {
      stampLayoutVersion(stashDir, CURRENT_LAYOUT_VERSION);
      stampReleaseVersion(stashDir, CURRENT_RELEASE_VERSION);
    }

    return {
      migrated: true,
      from,
      to: CURRENT_LAYOUT_VERSION,
      applied,
      backupDir,
      notes,
      releaseFrom,
      releaseTo: CURRENT_RELEASE_VERSION,
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
  const homeDir = opts.homeDir ?? resolveOpenPalmHome();
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? (() => {});
  const stashDir = resolveStashDir();
  const targetVersion = opts.targetVersion.trim();
  const releaseFrom = readReleaseVersion(stashDir);
  const pendingRelease = selectPendingReleaseMigrations(releaseFrom, targetVersion);
  const empty: ReleaseMigrationReport = {
    migrated: false,
    from: releaseFrom,
    to: targetVersion,
    applied: [],
    backupDir: null,
    notes: [],
  };

  if (pendingRelease.length === 0) {
    if (!dryRun && releaseFrom !== targetVersion) stampReleaseVersion(stashDir, targetVersion);
    return empty;
  }

  const ctxBase = {
    homeDir,
    dataDir: resolveDataDir(),
    stackDir: resolveStackDir(),
    stashDir,
    configDir: resolveConfigDir(),
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
      log('Taking a full backup before migrating…');
      try {
        backupDir = backupOpenPalmHome(homeDir);
      } catch (e) {
        throw new MigrationError(`Could not create a safety backup; upgrade aborted (no changes made): ${e instanceof Error ? e.message : String(e)}`, RECOVERY_GUIDANCE, null);
      }
      if (!backupDir) {
        throw new MigrationError('Could not create a safety backup; upgrade aborted (no changes made).', RECOVERY_GUIDANCE, null);
      }
      log(`Backup: ${backupDir}`);
    }

    const applied: string[] = [];
    const notes: string[] = [];
    for (const migration of pendingRelease) {
      const ctx: MigrationCtx = { ...ctxBase, notes };
      log(`Migrating release ${releaseFrom ?? 'unknown'} → ${migration.version}: ${migration.describe}`);
      migration.apply(ctx);
      migration.verify(ctx);
      applied.push(migration.version);
    }

    if (!dryRun) stampReleaseVersion(stashDir, targetVersion);

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
