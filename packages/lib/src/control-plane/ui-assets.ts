/** Host UI and skeleton resolution — local-only. Every artifact (containers,
 * Electron, CLI) ships its own UI build + skeleton at build time; this module
 * only resolves and materializes what is ALREADY on disk (or embedded in the
 * CLI binary — see packages/cli/src/lib/embedded-assets.ts). There is no
 * runtime download path: it was the GitHub host-assets release transport, and
 * it has been deleted along with backup/rollback/restart-on-update.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVersion } from './versioning.js';
import { SEEDED_SKILL_FILE_HASHES } from './seeded-skill-hashes.js';
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

/**
 * Every regular file under `root`, as paths relative to it, sorted — or null
 * when the tree holds an entry that is neither a directory nor a regular file.
 *
 * `readdirSync(withFileTypes)` reports on the entry itself, not its target, so
 * a symlink is neither `isDirectory()` nor `isFile()`. Skipping those would
 * make them invisible to the only caller, which asks "is everything here
 * ours?" and deletes the tree when the answer is yes — so they are reported as
 * the unreadable content they are instead.
 */
function listFilesRelative(root: string): string[] | null {
  const files: string[] = [];
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!walk(path)) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      files.push(relative(root, path));
    }
    return true;
  };
  return walk(root) ? files.sort() : null;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Whether every file in the stash copy of `name` is content OpenPalm shipped at
 * that path — i.e. nothing here is the operator's.
 *
 * A file passes if it matches what THIS build ships at the same skill-relative
 * path, or any content a previous release shipped there
 * ({@link SEEDED_SKILL_FILE_HASHES}). Unknown content or an unknown path fails
 * immediately, which is what makes an operator's edit — or a file of their own
 * dropped into a shipped skill's directory — hold the whole tree back.
 *
 * It fails closed on anything it cannot read as a file, because the caller
 * deletes the directory on a `true`: an unlistable entry (a symlink above all —
 * whose target must not be followed and must not be removed) and a listing with
 * no files in it at all (a bare directory, a tree of empty ones) both mean the
 * question was never actually answered. `.every()` over an empty list is
 * vacuously true, so that case has to be rejected here rather than left to it.
 */
function isPristineSeededSkill(shippedSkill: string, stashSkill: string, name: string): boolean {
  const files = listFilesRelative(stashSkill);
  if (files === null || files.length === 0) return false;
  return files.every((rel) => {
    const digest = sha256File(join(stashSkill, rel));
    const current = join(shippedSkill, rel);
    // statSync, not existsSync: a path the stash holds a file at can be a
    // DIRECTORY in this build's tree, and reading that as a file throws EISDIR
    // out of the whole lifecycle apply.
    if (statSync(current, { throwIfNoEntry: false })?.isFile() && sha256File(current) === digest) return true;
    // The manifest is keyed from knowledge/skills, so include the skill name.
    // POSIX separators there; readdir gives platform ones.
    return (SEEDED_SKILL_FILE_HASHES[`${name}/${rel.split(sep).join('/')}`] ?? []).includes(digest);
  });
}

/**
 * Drop stash copies of shipped skills the operator never touched.
 *
 * The release-shipped skills used to be seeded into `knowledge/skills/`. They
 * live in the managed tree now, which is what gives them an update channel —
 * but a copy left behind in the stash is indexed by akm from the primary bundle
 * as well, and the stash copy is the one `akm show skills/<name>` resolves to.
 * So a leftover does not merely duplicate the shipped skill, it SHADOWS it, and
 * the update channel the move existed to create never reaches the assistant.
 *
 * This ran on "byte-identical to what this build ships", which was only ever
 * true of a home this build seeded. Shipped content changed between 0.12.x and
 * 0.13.0, so on every upgraded home all three names differed, all three were
 * kept, and all three shadowed — the move worked on fresh installs only. The
 * test is now "every file is content OpenPalm is known to have shipped at that
 * path", against this build plus the frozen record of earlier ones, which
 * answers the question that was actually being asked.
 *
 * The hard rule is unchanged and is what the per-file check protects: content
 * matching no release's bytes at that path is NEVER deleted. Anything that
 * fails the test stays, still shadowing the shipped copy, and is named in a
 * warning so the duplicate is visible rather than silent — that case remains
 * the operator's to resolve. The one edit the rule cannot see is one that
 * reproduces an earlier release's file exactly (pinning a stash copy back to
 * the 0.12 text, say): it is indistinguishable from never having touched it,
 * and is dropped as pristine.
 *
 * It runs here, not as a schema-gated migration, because this is the one point
 * where `system/skills/` is guaranteed to hold exactly what this release ships:
 * `overwriteSystemTree` has just written it. Removal is idempotent, so a second
 * pass finds nothing left to remove and it needs no version gate.
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
    if (!isPristineSeededSkill(join(shipped, entry.name), mine, entry.name)) {
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

/** Suffix that takes a task file out of akm's `tasks/*.yml` glob, and ours. */
const PRE_V4_TASK_SUFFIX = '.pre-v4';

/**
 * Move aside seeded task files that predate akm task source v4, so the seed
 * below can write this release's version over the gap.
 *
 * `knowledge/tasks/` is seeded with skipExisting=true, which makes the shipped
 * task files a ONE-TIME copy: the four this release rewrote as `version: 4` sit
 * on every existing home as the `version: 2` documents they were installed as,
 * and no amount of upgrading replaces them. That is not merely stale. akm 0.9.4
 * validates the ENTIRE desired task set before it mutates the scheduler, so one
 * file it cannot read stops cron registration for every task on the box —
 * including the operator's own — and `akm migrate apply` cannot dig the home
 * out either, being all-or-nothing itself and blocked on these exact files
 * (`argv-array-has-no-portable-shell-string`, which is why they had to be
 * converted by hand rather than by the migrator).
 *
 * RENAMED, not deleted, and that is the whole design. Telling a pristine seed
 * from an operator's edit of one would need a frozen record of every byte
 * OpenPalm ever shipped at these paths (the {@link SEEDED_SKILL_FILE_HASHES}
 * treatment), and getting that answer wrong in the safe direction — keep the
 * file, warn — leaves their scheduler dead. Setting it aside needs no such
 * record: an edited file is preserved in full at a name the operator can see
 * and rename back, a pristine one leaves an inert copy of content they never
 * chose, and cron comes back either way.
 *
 * Only the names THIS build ships are considered, so a task the operator wrote
 * is never touched — including a v2 one, which akm still reads through its
 * conversion shim.
 */
function retirePreV4SeededTasks(source: string, homeDir: string): void {
  const shipped = join(source, 'knowledge', 'tasks');
  const installed = join(homeDir, 'knowledge', 'tasks');
  if (!existsSync(shipped) || !existsSync(installed)) return;

  const retired: string[] = [];
  for (const entry of readdirSync(shipped, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yml')) continue;
    const mine = join(installed, entry.name);
    if (statSync(mine, { throwIfNoEntry: false })?.isFile() !== true) continue;
    if (declaresTaskSourceV4(mine)) continue;
    try {
      renameSync(mine, `${mine}${PRE_V4_TASK_SUFFIX}`);
      retired.push(entry.name);
    } catch { /* best-effort: a home we cannot clean is not one we refuse to start */ }
  }
  if (retired.length > 0) {
    logger.warn(
      `Set aside pre-v4 copies of shipped task files as *${PRE_V4_TASK_SUFFIX} and reseeded them; akm 0.9.4 could not read them, which stopped cron registration for every task`,
      { retired },
    );
  }
}

/** Whether a task file declares the one source version akm 0.9.4 reads natively. */
function declaresTaskSourceV4(path: string): boolean {
  try {
    const doc = parseYaml(readFileSync(path, 'utf8'));
    return !!doc && typeof doc === 'object' && !Array.isArray(doc) && (doc as { version?: unknown }).version === 4;
  } catch {
    // Unparseable is not v4, and akm will reject it too — set it aside.
    return false;
  }
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
  // Before the seed, not after: the seed skips a path that already exists, so
  // the stale file has to be out of the way for the current one to land.
  retirePreV4SeededTasks(source, homeDir);
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
