/**
 * Core runtime asset management for the OpenPalm control plane.
 *
 * Manages source-of-truth files for the ~/.openpalm/ layout:
 *   system/stack/       — system-owned compose files, refreshed every reconcile
 *
 * This module manages runtime-owned core files only.
 * Addon compose bundle generation and registry catalog refresh are handled
 * separately in registry.ts.
 * Env validation has moved to `akm vault` + the in-house redactor — the
 * historical `.env.schema` files (varlock format) were retired in #391.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { errMessage } from "./errors.js";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
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

export function readCoreCompose(): string {
  const livePath = `${resolveOpenPalmHome()}/system/stack/core.compose.yml`;
  if (existsSync(livePath)) {
    return readFileSync(livePath, 'utf-8');
  }
  return readFileSync(bundledAssetPath('system/stack/core.compose.yml'), 'utf-8');
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
    return readFileSync(bundledAssetPath(`system/stack/${name}`), 'utf-8');
  } catch (err) {
    logger.warn('bundled stack asset unavailable (returning empty)', {
      name,
      error: errMessage(err),
    });
    return '';
  }
}

/**
 * The bundled USER custom.compose.yml default. Unlike the managed trio it ships
 * in the user tree (config/stack/), so it is resolved separately. Used only to
 * seed the file once when absent — never to overwrite an existing user overlay.
 */
export function readBundledCustomCompose(): string {
  try {
    return readFileSync(bundledAssetPath('config/stack/custom.compose.yml'), 'utf-8');
  } catch (err) {
    logger.warn('bundled custom.compose.yml unavailable (returning empty)', {
      error: errMessage(err),
    });
    return '';
  }
}

// ── OpenCode System Config ──────────────────────────────────────────

export function ensureOpenCodeSystemConfig(): void {
  const dir = `${resolveDataDir()}/assistant`;
  mkdirSync(dir, { recursive: true });
}

// ── Managed system/ tree overwrite ───────────────────────────────────

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

/**
 * Overwrite the entire MANAGED `system/` tree from the release skeleton.
 *
 * This is the "overwrite the managed tree" primitive (constitution §1):
 * `system/` IS the skeleton, so every install/update blind-copies the release's
 * `system/` over OP_HOME/system — compose stack AND the system OpenCode config
 * (plugins/permissions/instructions). Unchanged files are skipped; changed ones
 * are backed up first (full recovery). User trees, `data/`, and `state/` are
 * NEVER touched here — that is the caller's seed-if-missing step.
 */
export function overwriteSystemTree(sourceRoot: string, homeDir = resolveOpenPalmHome()): {
  backupDir: string | null;
  updated: string[];
} {
  const updated: string[] = [];
  let backupDir: string | null = null;

  const sysSource = join(sourceRoot, 'system');
  if (!existsSync(sysSource)) return { backupDir, updated };

  for (const entry of readdirSync(sysSource, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parentDir = (entry as unknown as { parentPath?: string; path?: string }).parentPath
      ?? (entry as unknown as { path: string }).path;
    const sourcePath = join(parentDir, entry.name);
    const rel = join('system', relative(sysSource, sourcePath));
    const targetPath = join(homeDir, rel);
    const freshContent = readFileSync(sourcePath);

    if (existsSync(targetPath)) {
      const currentContent = readFileSync(targetPath);
      if (sha256(currentContent.toString('utf-8')) === sha256(freshContent.toString('utf-8'))) continue;
      backupDir = backupExistingFile(targetPath, rel, backupDir);
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, freshContent);
    updated.push(rel);
  }

  return { backupDir, updated };
}

