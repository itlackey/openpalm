/** Host UI and skeleton resolution — local-only. Every artifact (containers,
 * Electron, CLI) ships its own UI build + skeleton at build time; this module
 * only resolves and materializes what is ALREADY on disk (or embedded in the
 * CLI binary — see packages/cli/src/lib/embedded-assets.ts). There is no
 * runtime download path: it was the GitHub host-assets release transport, and
 * it has been deleted along with backup/rollback/restart-on-update.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVersion } from './versioning.js';
import { resolveDataDir } from './home.js';
import { overwriteSystemTree } from './core-assets.js';

export const UI_VERSION_STAMP = '.openpalm-ui-version';
export const SKELETON_VERSION_STAMP = '.skeleton-version';

function localCandidate(...strategies: Array<() => string | null>): string | null {
  for (const strategy of strategies) {
    try { const candidate = strategy(); if (candidate && existsSync(candidate)) return candidate; } catch { /* optional source */ }
  }
  return null;
}

function copyTree(source: string, destination: string, skipExisting = false): void {
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? (entry as unknown as { path: string }).path;
    const sourceFile = join(parent, entry.name);
    const target = join(destination, relative(source, sourceFile));
    if (skipExisting && existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(sourceFile, target);
  }
}

export function resolveLocalOpenpalmDir(): string | null {
  return localCandidate(
    () => process.env.OPENPALM_REPO_ROOT ? join(process.env.OPENPALM_REPO_ROOT, 'packages', 'skeleton') : null,
    () => process.env.OPENPALM_SKELETON_DIR ?? null,
    () => join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'skeleton'),
  );
}

/**
 * A "bundled" UI build resolvable directly off disk: an Electron
 * extraResources copy, a repo checkout (dev), or an explicit
 * OPENPALM_REPO_ROOT override. A compiled CLI binary has none of these — its
 * build is embedded in the executable and must be materialized into data/ui
 * first (see packages/cli/src/lib/embedded-assets.ts) — so this naturally
 * returns null there and {@link resolveUiBuildDir} falls back to data/ui.
 */
export function resolveLocalUiBuild(): string | null {
  return localCandidate(
    () => process.env.OPENPALM_REPO_ROOT ? join(process.env.OPENPALM_REPO_ROOT, 'packages', 'ui', 'build') : null,
    () => { const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath; return resources ? join(resources, 'ui-build') : null; },
    () => join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'ui', 'build'),
  );
}

export function readUiBuildVersion(dir: string): string | null {
  try { return readFileSync(join(dir, UI_VERSION_STAMP), 'utf8').trim() || null; } catch { return null; }
}
export function readSkeletonVersion(homeDir: string): string | null {
  try { return readFileSync(join(homeDir, SKELETON_VERSION_STAMP), 'utf8').trim() || null; } catch { return null; }
}
function writeSkeletonVersion(homeDir: string, version: string): void { writeFileSync(join(homeDir, SKELETON_VERSION_STAMP), `${version}\n`); }

/**
 * Seed OP_HOME's managed system/ tree (+ any other skeleton files) from a
 * local skeleton source — an Electron extraResources copy, a repo checkout,
 * or (for the CLI) an embedded copy materialized by the caller and pointed to
 * via OPENPALM_SKELETON_DIR before calling this. No network fallback: every
 * consumer ships its own skeleton at build time now.
 */
export async function applyHomeSeed(_repoRef: string, homeDir: string, _configDir: string, _dataDir: string): Promise<{ updated: string[]; backupDir: string | null }> {
  const source = resolveLocalOpenpalmDir();
  if (!source) return { updated: [], backupDir: null };
  const managed = overwriteSystemTree(source, homeDir);
  copyTree(source, homeDir, true);
  try {
    const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
    if (typeof version === 'string') writeSkeletonVersion(homeDir, normalizeVersion(version));
  } catch { /* optional: not every local source carries a package.json */ }
  return managed;
}

/**
 * Resolve the UI build to serve: a bundled/embedded build when one is
 * resolvable, otherwise the materialized copy in data/ui. There is no
 * version arbitration anymore — every consumer's bundled build IS its
 * current version, and data/ui only exists at all for the CLI, which
 * materializes its embedded build there once per version (see
 * packages/cli/src/lib/embedded-assets.ts).
 */
export function resolveUiBuildDir(): string {
  const bundled = resolveLocalUiBuild();
  if (bundled && existsSync(join(bundled, 'index.js'))) return bundled;
  return join(resolveDataDir(), 'ui');
}
