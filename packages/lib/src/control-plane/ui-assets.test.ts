import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyHomeSeed,
  readSkeletonVersion,
  resolveLocalOpenpalmDir,
  resolveLocalUiBuild,
  resolveUiBuildDir,
} from './ui-assets.js';

// NOTE: the repo's bun test preload (scripts/test-isolate-op-home.ts) always
// sets OPENPALM_REPO_ROOT to the real checkout so skeleton/UI-build resolution
// works in every suite. Tests here that need to exercise a LOWER-precedence
// strategy must explicitly unset it, and restore it afterward — never assume
// "unset" reflects a real end-user environment.
const originalRepoRoot = process.env.OPENPALM_REPO_ROOT;
const originalSkeletonDir = process.env.OPENPALM_SKELETON_DIR;
const originalHome = process.env.OP_HOME;

afterEach(() => {
  if (originalRepoRoot === undefined) delete process.env.OPENPALM_REPO_ROOT;
  else process.env.OPENPALM_REPO_ROOT = originalRepoRoot;
  if (originalSkeletonDir === undefined) delete process.env.OPENPALM_SKELETON_DIR;
  else process.env.OPENPALM_SKELETON_DIR = originalSkeletonDir;
  if (originalHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = originalHome;
});

// Every consumer ships its own UI build + skeleton at build time now — this
// module only resolves what's already on disk (or, for the CLI, what the
// caller materialized locally and pointed OPENPALM_SKELETON_DIR at). There is
// no network fallback to test.

describe('resolveLocalOpenpalmDir', () => {
  test('resolves an explicit OPENPALM_SKELETON_DIR override when no repo root is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openpalm-skel-'));
    try {
      delete process.env.OPENPALM_REPO_ROOT;
      process.env.OPENPALM_SKELETON_DIR = dir;
      expect(resolveLocalOpenpalmDir()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('OPENPALM_REPO_ROOT takes precedence over OPENPALM_SKELETON_DIR', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'openpalm-repo-'));
    const skeletonDir = join(repoRoot, 'packages', 'skeleton');
    mkdirSync(skeletonDir, { recursive: true });
    try {
      process.env.OPENPALM_REPO_ROOT = repoRoot;
      process.env.OPENPALM_SKELETON_DIR = '/nonexistent-should-lose';
      expect(resolveLocalOpenpalmDir()).toBe(skeletonDir);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveLocalUiBuild', () => {
  test('resolves packages/ui/build under an explicit OPENPALM_REPO_ROOT', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'openpalm-repo-ui-'));
    const buildDir = join(repoRoot, 'packages', 'ui', 'build');
    mkdirSync(buildDir, { recursive: true });
    try {
      process.env.OPENPALM_REPO_ROOT = repoRoot;
      expect(resolveLocalUiBuild()).toBe(buildDir);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveUiBuildDir', () => {
  test('prefers a resolvable bundled build over data/ui', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'openpalm-repo-resolve-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-resolve-'));
    const buildDir = join(repoRoot, 'packages', 'ui', 'build');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, 'index.js'), 'export {};\n');
    try {
      process.env.OPENPALM_REPO_ROOT = repoRoot;
      process.env.OP_HOME = home;
      expect(resolveUiBuildDir()).toBe(buildDir);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('falls back to data/ui when the resolvable bundled dir has no build in it', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'openpalm-repo-empty-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-fallback-'));
    try {
      // packages/ui/build resolves (the join exists) but is empty — no index.js.
      mkdirSync(join(repoRoot, 'packages', 'ui', 'build'), { recursive: true });
      process.env.OPENPALM_REPO_ROOT = repoRoot;
      process.env.OP_HOME = home;
      expect(resolveUiBuildDir()).toBe(join(home, 'data', 'ui'));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('applyHomeSeed', () => {
  // NOTE: the "no local skeleton source resolves → throws" branch cannot be
  // exercised from a repo checkout: the source-relative fallback in
  // resolveLocalOpenpalmDir always resolves packages/skeleton here. It only
  // triggers in a compiled binary that failed to materialize its embedded
  // skeleton, which is exactly the silent-stale-update failure the throw exists
  // to surface.

  test('overwrites the managed system/ tree from a local skeleton source and stamps its version', async () => {
    const skeletonSrc = mkdtempSync(join(tmpdir(), 'openpalm-skeleton-src-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-applyseed-'));
    mkdirSync(join(skeletonSrc, 'system', 'stack'), { recursive: true });
    writeFileSync(join(skeletonSrc, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
    writeFileSync(join(skeletonSrc, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    try {
      delete process.env.OPENPALM_REPO_ROOT;
      process.env.OPENPALM_SKELETON_DIR = skeletonSrc;
      await applyHomeSeed(home);
      expect(readSkeletonVersion(home)).toBe('1.2.3');
    } finally {
      rmSync(skeletonSrc, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('drops a stash skill byte-identical to the shipped one and keeps a modified or operator-authored one', async () => {
    const skeletonSrc = mkdtempSync(join(tmpdir(), 'openpalm-skeleton-skills-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-skills-'));
    mkdirSync(join(skeletonSrc, 'system', 'skills', 'notify'), { recursive: true });
    mkdirSync(join(skeletonSrc, 'system', 'skills', 'config-diagnostics'), { recursive: true });
    writeFileSync(join(skeletonSrc, 'system', 'skills', 'notify', 'SKILL.md'), 'shipped notify\n');
    writeFileSync(join(skeletonSrc, 'system', 'skills', 'config-diagnostics', 'SKILL.md'), 'shipped diag\n');
    // The stash copies an older release seeded: one pristine, one the operator
    // edited, one of their own that never shipped.
    mkdirSync(join(home, 'knowledge', 'skills', 'notify'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'skills', 'config-diagnostics'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'skills', 'mine'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'skills', 'notify', 'SKILL.md'), 'shipped notify\n');
    writeFileSync(join(home, 'knowledge', 'skills', 'config-diagnostics', 'SKILL.md'), 'my edits\n');
    writeFileSync(join(home, 'knowledge', 'skills', 'mine', 'SKILL.md'), 'mine\n');
    try {
      delete process.env.OPENPALM_REPO_ROOT;
      process.env.OPENPALM_SKELETON_DIR = skeletonSrc;
      await applyHomeSeed(home);

      expect(existsSync(join(home, 'knowledge', 'skills', 'notify'))).toBe(false);
      expect(readFileSync(join(home, 'knowledge', 'skills', 'config-diagnostics', 'SKILL.md'), 'utf8')).toBe('my edits\n');
      expect(readFileSync(join(home, 'knowledge', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('mine\n');

      // Idempotent by construction: a second seed removes nothing further.
      await applyHomeSeed(home);
      expect(readFileSync(join(home, 'knowledge', 'skills', 'config-diagnostics', 'SKILL.md'), 'utf8')).toBe('my edits\n');
      expect(readFileSync(join(home, 'knowledge', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('mine\n');
    } finally {
      rmSync(skeletonSrc, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an emptied knowledge/skills is removed, so akm does not index a bare dir', async () => {
    const skeletonSrc = mkdtempSync(join(tmpdir(), 'openpalm-skeleton-skills-empty-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-skills-empty-'));
    mkdirSync(join(skeletonSrc, 'system', 'skills', 'notify'), { recursive: true });
    writeFileSync(join(skeletonSrc, 'system', 'skills', 'notify', 'SKILL.md'), 'shipped notify\n');
    mkdirSync(join(home, 'knowledge', 'skills', 'notify'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'skills', 'notify', 'SKILL.md'), 'shipped notify\n');
    try {
      delete process.env.OPENPALM_REPO_ROOT;
      process.env.OPENPALM_SKELETON_DIR = skeletonSrc;
      await applyHomeSeed(home);
      expect(existsSync(join(home, 'knowledge', 'skills'))).toBe(false);
    } finally {
      rmSync(skeletonSrc, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
