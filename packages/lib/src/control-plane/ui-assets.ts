/** Host UI and skeleton resolution — local-only. Every artifact (containers,
 * Electron, CLI) ships its own UI build + skeleton at build time; this module
 * only resolves and materializes what is ALREADY on disk (or embedded in the
 * CLI binary — see packages/cli/src/lib/embedded-assets.ts). There is no
 * runtime download path: it was the GitHub host-assets release transport, and
 * it has been deleted along with backup/rollback/restart-on-update.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVersion } from './versioning.js';
import { resolveDataDir } from './home.js';
import { overwriteSystemTree } from './core-assets.js';
import { createLogger } from '../logger.js';

const logger = createLogger('ui-assets');

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

/** Every regular file under `root`, as paths relative to it, sorted. */
function listFilesRelative(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  };
  walk(root);
  return files.sort();
}

/** Same file list, same bytes. */
function treesIdentical(a: string, b: string): boolean {
  const left = listFilesRelative(a);
  const right = listFilesRelative(b);
  if (left.length !== right.length || left.some((rel, i) => rel !== right[i])) return false;
  return left.every((rel) => readFileSync(join(a, rel)).equals(readFileSync(join(b, rel))));
}

/**
 * Drop stash copies of shipped skills that are byte-identical to the ones just
 * refreshed into `system/skills/`.
 *
 * The release-shipped skills used to be seeded into `knowledge/skills/`. They
 * live in the managed tree now, which is what gives them an update channel —
 * but an identical copy left behind in the stash is indexed by akm twice, once
 * from the primary bundle and once from the `:ro` system bundle.
 *
 * This runs here, not as a schema-gated migration, because this is the one
 * point where `system/skills/` is guaranteed to hold exactly what this release
 * ships: `overwriteSystemTree` has just written it. It removes only trees
 * byte-identical to the shipped ones, so a second pass finds nothing left to
 * remove and it needs no version gate. Anything that differs is the operator's
 * own — it stays and shadows the shipped copy, and is named in a warning so
 * the duplicate is visible rather than silent.
 */
function pruneDuplicateShippedSkills(homeDir: string): void {
  const shipped = join(homeDir, 'system', 'skills');
  const stash = join(homeDir, 'knowledge', 'skills');
  if (!existsSync(shipped) || !existsSync(stash)) return;

  const removed: string[] = [];
  const kept: string[] = [];
  for (const entry of readdirSync(shipped, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mine = join(stash, entry.name);
    if (!existsSync(mine)) continue;
    if (!treesIdentical(join(shipped, entry.name), mine)) {
      kept.push(entry.name);
      continue;
    }
    rmSync(mine, { recursive: true, force: true });
    removed.push(entry.name);
  }
  if (removed.length > 0) {
    logger.warn('Removed shipped skills from knowledge/skills — they are served from the managed system/skills bundle now', { removed });
  }
  if (kept.length > 0) {
    logger.warn('Kept locally modified copies of shipped skills in knowledge/skills; they now shadow the system/skills bundle and are yours to maintain', { kept });
  }
  // Emptied by the sweep: leave it only if the operator has skills of their own.
  try { rmdirSync(stash); } catch { /* non-empty */ }
}

/**
 * Seed OP_HOME's managed system/ tree (+ any other skeleton files) from a
 * local skeleton source — an Electron extraResources copy, a repo checkout,
 * or (for the CLI) an embedded copy materialized by the caller and pointed to
 * via OPENPALM_SKELETON_DIR before calling this. No network fallback: every
 * consumer ships its own skeleton at build time now.
 */
export async function applyHomeSeed(homeDir: string): Promise<{ updated: string[]; backupDir: string | null }> {
  const source = resolveLocalOpenpalmDir();
  if (!source) {
    // A silent no-op here would let an update bump image versions while
    // deploying the previous release's compose tree. Fail loudly instead.
    throw new Error(
      'OpenPalm skeleton assets not found: no local skeleton source resolved. ' +
      'Set OPENPALM_SKELETON_DIR to a materialized skeleton directory or OPENPALM_REPO_ROOT to a repo checkout.'
    );
  }
  const managed = overwriteSystemTree(source, homeDir);
  // K7, resolved: the release-shipped skills moved to system/skills/, so
  // overwriteSystemTree above refreshes them wholesale and a skill bugfix now
  // reaches an existing OP_HOME. They used to sit under knowledge/skills/,
  // where the skipExisting=true seed below made them a one-time copy — a
  // later fix only ever reached a brand-new home, with no update channel and
  // no signal that anything was stale. skipExisting stays right for what is
  // left here (knowledge/env/user.env, knowledge/secrets/, config/, data/,
  // workspace/ — genuinely user-owned or user-populated).
  pruneDuplicateShippedSkills(homeDir);
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
