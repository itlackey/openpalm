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
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import {
  resolveOpenPalmHome, resolveDataDir, resolveStackDir, resolveStashDir, resolveConfigDir,
} from "./home.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import { backupOpenPalmHome } from "./backup.js";
import { upsertEnvValue } from "./env.js";

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
  const empty: MigrationReport = { migrated: false, from, to: from, applied: [], backupDir: null, notes: [] };

  // Fast path: already current → just ensure the marker is stamped, no lock/backup.
  if (from >= CURRENT_LAYOUT_VERSION) {
    if (!dryRun) stampLayoutVersion(stashDir, CURRENT_LAYOUT_VERSION);
    return { ...empty, to: CURRENT_LAYOUT_VERSION };
  }

  const pending = MIGRATIONS
    .filter((m) => m.from >= from && m.to <= CURRENT_LAYOUT_VERSION)
    .sort((a, b) => a.from - b.from);
  if (pending.length === 0) {
    if (!dryRun) stampLayoutVersion(stashDir, CURRENT_LAYOUT_VERSION);
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
    const notes: string[] = [];
    for (const m of pending) {
      const ctx: MigrationCtx = { ...ctxBase, notes };
      log(`Migrating layout ${m.from} → ${m.to}: ${m.describe}`);
      m.apply(ctx);
      m.verify(ctx);
      applied.push(`${m.from}->${m.to}`);
    }

    // Commit point: bump the layout version LAST.
    if (!dryRun) stampLayoutVersion(stashDir, CURRENT_LAYOUT_VERSION);

    return { migrated: true, from, to: CURRENT_LAYOUT_VERSION, applied, backupDir, notes };
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
