/**
 * Core runtime asset management for the OpenPalm control plane.
 *
 * Manages source-of-truth files for the ~/.openpalm/ layout:
 *   stack/              — compose runtime assets (core.compose.yml)
 *   config/guardian/    — guardian OpenCode config (skip-if-user-modified)
 *
 * This module manages runtime-owned core files only.
 * Addon compose bundle generation and registry catalog refresh are handled
 * separately in registry.ts.
 * Env validation has moved to `akm vault` + the in-house redactor — the
 * historical `.env.schema` files (varlock format) were retired in #391.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir, resolveOpenPalmHome, resolveBackupsDir } from "./home.js";
import { createLogger } from "../logger.js";
import { sha256 } from "./crypto.js";

const logger = createLogger("core-assets");

const _require = createRequire(import.meta.url);

function bundledAssetPath(relPath: string): string {
  // 1. @openpalm/skeleton installed as a package dep (CLI bundled, npm install)
  try {
    const pkgPath = _require.resolve('@openpalm/skeleton/package.json');
    return join(dirname(pkgPath), relPath);
  } catch { /* fall through */ }

  // 2. OPENPALM_REPO_ROOT env var (explicit dev override or test preload)
  const repoRoot = process.env.OPENPALM_REPO_ROOT;
  if (repoRoot) return join(repoRoot, 'packages', 'skeleton', relPath);

  // 3. Source-relative fallback — works when running from the repo tree
  //    (bun run, bun test). This file lives at
  //    packages/lib/src/control-plane/core-assets.ts; skeleton is four levels up.
  try {
    const meta = fileURLToPath(import.meta.url);
    const candidate = join(dirname(meta), '..', '..', '..', '..', 'packages', 'skeleton', relPath);
    // Only return this candidate if the skeleton package.json exists (sanity check)
    if (existsSync(join(dirname(meta), '..', '..', '..', '..', 'packages', 'skeleton', 'package.json'))) {
      return candidate;
    }
  } catch { /* fall through */ }

  throw new Error('@openpalm/skeleton not found. Set OPENPALM_REPO_ROOT or install @openpalm/skeleton.');
}

// ── Core Compose (stack/) ─────────────────────────────────────────────

export function ensureCoreCompose(): string {
  const path = `${resolveOpenPalmHome()}/config/stack/core.compose.yml`;
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function readCoreCompose(): string {
  const livePath = `${resolveOpenPalmHome()}/config/stack/core.compose.yml`;
  if (existsSync(livePath)) {
    return readFileSync(livePath, 'utf-8');
  }
  return readFileSync(bundledAssetPath('config/stack/core.compose.yml'), 'utf-8');
}

export function readBundledStackAsset(name: string): string {
  // The bundled `.openpalm` assets are resolved relative to import.meta.url,
  // which does not survive bundling into the UI/Electron build (the path lands
  // outside the packaged app). When OP_HOME is already seeded this fallback is
  // never reached; when it is NOT (e.g. a fresh Electron first-run) the read
  // fails. Degrade gracefully to "" so callers (addon profile/service lookups)
  // return empty rather than throwing a 500 — the live OP_HOME assets are the
  // source of truth once seeded.
  try {
    return readFileSync(bundledAssetPath(`config/stack/${name}`), 'utf-8');
  } catch (err) {
    logger.warn('bundled stack asset unavailable (returning empty)', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

// ── OpenCode System Config ──────────────────────────────────────────

export function ensureOpenCodeSystemConfig(): void {
  const dir = `${resolveDataDir()}/assistant`;
  mkdirSync(dir, { recursive: true });
}

// ── Guardian managed assets (skip-if-user-modified) ──────────────────
//
// These are guardian config files that ship with sensible defaults but are
// intentionally editable by operators (e.g. moderation instructions).
//
// Policy (owner decision #1, approved):
//   On refresh, a guardian managed asset is only overwritten when its current
//   on-disk content is byte-identical to *some* previously shipped default.
//   If the operator has edited it, the file is KEPT and a notice is surfaced
//   ("new default available; yours kept") — the file is NEVER silently clobbered.
//
// SHIPPED_DEFAULT_HASHES maps relPath → ordered list of sha256 hex digests of
// every previously released default for that file. Add a new entry here whenever
// the bundled default changes across a release so older installs stay upgradeable.

export const SHIPPED_DEFAULT_HASHES: Record<string, string[]> = {
  "config/guardian/instructions/moderation.md": [
    // v0.12.0 shipped default
    "dfa770d433bef9954e58e29cfb337679eb27ed3c9de61ddd2c4106d3add9a628",
  ],
};

/** Assets under config/guardian/ that are managed (refreshable) but respect user edits. */
export const GUARDIAN_MANAGED_ASSETS: { relPath: string }[] = [
  { relPath: "config/guardian/instructions/moderation.md" },
];

/**
 * Returns true when the on-disk content is still byte-identical to one of the
 * previously shipped defaults for the given relPath (i.e. the user has not
 * edited it and it is safe to overwrite on refresh).
 */
export function isUnmodifiedDefault(relPath: string, currentContent: string): boolean {
  const known = SHIPPED_DEFAULT_HASHES[relPath];
  if (!known || known.length === 0) return false;
  const h = sha256(currentContent);
  return known.includes(h);
}

// ── Managed / Seeded asset manifests ─────────────────────────────────
//
// Asset refresh is always a LOCAL copy from the bundled @openpalm/skeleton
// source (refreshCoreAssetsFromSource). There is no GitHub/registry download:
// OP_HOME assets are materialized from the skeleton that ships with the running
// control plane, keyed on PLATFORM_VERSION via seedOpenPalmDir's stamp.

// Persona files (openpalm.md, system.md), stash seeds, and user-editable config
// files are intentionally NOT in this list. They are seeded once (never
// overwritten) via seedOpenPalmDir (skipExisting) or SEEDED_ASSETS below.
export const MANAGED_ASSETS: { relPath: string }[] = [
  { relPath: "config/stack/core.compose.yml" },
  { relPath: "config/stack/services.compose.yml" },
  { relPath: "config/stack/portals.compose.yml" },
];

// Seeded once — written only when the file does not exist yet.
// User edits always win; upgrade never touches these files.
export const SEEDED_ASSETS: { relPath: string }[] = [
  { relPath: "config/assistant/opencode.jsonc" },
  { relPath: "config/stack/custom.compose.yml" },
];

function ensureBackupDir(backupDir: string | null, suffix = ''): string {
  if (backupDir) return backupDir;
  return join(resolveBackupsDir(), `${new Date().toISOString().replace(/[:.]/g, "-")}${suffix}`);
}

function backupExistingFile(targetPath: string, assetRelPath: string, backupDir: string | null, suffix = ''): string {
  const resolvedBackupDir = ensureBackupDir(backupDir, suffix);
  const backupPath = join(resolvedBackupDir, assetRelPath);
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(targetPath, backupPath);
  return resolvedBackupDir;
}

export function refreshCoreAssetsFromSource(sourceRoot: string, homeDir = resolveOpenPalmHome()): {
  backupDir: string | null;
  updated: string[];
  kept: string[];
} {
  const updated: string[] = [];
  const kept: string[] = [];
  let backupDir: string | null = null;

  for (const asset of MANAGED_ASSETS) {
    const sourcePath = join(sourceRoot, asset.relPath);
    const targetPath = join(homeDir, asset.relPath);
    const freshContent = readFileSync(sourcePath, 'utf-8');

    if (existsSync(targetPath)) {
      const currentContent = readFileSync(targetPath, 'utf-8');
      if (sha256(currentContent) === sha256(freshContent)) continue;
      backupDir = backupExistingFile(targetPath, asset.relPath, backupDir);
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, freshContent);
    updated.push(asset.relPath);
  }

  // Guardian managed assets: skip-if-user-modified (owner decision #1).
  for (const asset of GUARDIAN_MANAGED_ASSETS) {
    const sourcePath = join(sourceRoot, asset.relPath);
    const targetPath = join(homeDir, asset.relPath);
    if (!existsSync(sourcePath)) continue;
    const freshContent = readFileSync(sourcePath, 'utf-8');

    if (existsSync(targetPath)) {
      const currentContent = readFileSync(targetPath, 'utf-8');
      if (sha256(currentContent) === sha256(freshContent)) continue;
      if (!isUnmodifiedDefault(asset.relPath, currentContent)) {
        // User has edited this file — keep it, surface a notice.
        logger.info('guardian managed asset kept (user-modified); new default available', {
          path: asset.relPath,
          hint: 'Remove the file or restore the shipped default to pick up the new version on the next refresh.',
        });
        kept.push(asset.relPath);
        continue;
      }
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, freshContent);
    updated.push(asset.relPath);
  }

  for (const asset of SEEDED_ASSETS) {
    const sourcePath = join(sourceRoot, asset.relPath);
    const targetPath = join(homeDir, asset.relPath);
    if (existsSync(targetPath)) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(sourcePath, 'utf-8'));
    updated.push(asset.relPath);
  }

  return { backupDir, updated, kept };
}

// ── Assistant Persona File Seeding ────────────────────────────────────

/**
 * Seed assistant persona files (openpalm.md, system.md) into OP_HOME.
 *
 * Idempotent: **never overwrites** an existing file — user edits always
 * win. This preserves the "config/ is user-owned" contract: persona files
 * are seeded once on first install and never touched again on update.
 *
 * `seeds` maps relative path keys (e.g. `"config/assistant/openpalm.md"`)
 * to file content. Each file is written to `resolveOpenPalmHome()/<relPath>`
 * only if the file does not already exist.
 *
 * Returns the list of relative paths that were actually written (empty on
 * re-run when every seed already exists on disk).
 */
export function seedAssistantPersonaFiles(seeds: Record<string, string>): string[] {
  const homeDir = resolveOpenPalmHome();
  const written: string[] = [];
  for (const [relPath, content] of Object.entries(seeds)) {
    const targetPath = join(homeDir, relPath);
    if (existsSync(targetPath)) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content);
    written.push(relPath);
  }
  return written;
}
