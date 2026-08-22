import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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


// Byte-exact content of a `knowledge/skills/install-optional-tool/tools.json`
// an earlier release seeded. Reformatting this changes its hash and breaks the
// upgrade test below; it is a fixture, not code.
const PREVIOUSLY_SHIPPED_TOOLS_JSON = `{
  "codex": {
    "label": "Codex CLI",
    "kind": "npm",
    "package": "@openai/codex",
    "version": "0.142.5",
    "bin": "codex"
  },
  "claude": {
    "label": "Claude Code",
    "kind": "npm",
    "package": "@anthropic-ai/claude-code",
    "version": "2.1.220",
    "bin": "claude"
  },
  "copilot": {
    "label": "GitHub Copilot CLI",
    "kind": "npm",
    "package": "@github/copilot",
    "version": "1.0.75",
    "bin": "copilot"
  },
  "pi": {
    "label": "Pi Coding Agent",
    "kind": "npm",
    "package": "@mariozechner/pi-coding-agent",
    "version": "0.73.1",
    "bin": "pi"
  },
  "gcloud": {
    "label": "Google Cloud CLI",
    "kind": "gcloud-sdk",
    "bin": "gcloud"
  }
}
`;

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

  // The 0.13.0 defect. This prune compared against what THIS build ships, so it
  // only ever matched a home this build had seeded. An UPGRADED home holds the
  // content of whichever release seeded it, so nothing matched, every shipped
  // skill was kept, and the stale copies went on shadowing the system/skills
  // bundle the move existed to serve them from. The bytes below are a real
  // previously-shipped `install-optional-tool/tools.json` and are load-bearing:
  // they must hash to an entry in SEEDED_SKILL_FILE_HASHES.
  test('drops a stash skill an EARLIER release seeded, whose content this build no longer ships', async () => {
    const skeletonSrc = mkdtempSync(join(tmpdir(), 'openpalm-skeleton-skills-old-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-skills-old-'));
    const shippedSkill = join(skeletonSrc, 'system', 'skills', 'install-optional-tool');
    mkdirSync(shippedSkill, { recursive: true });
    writeFileSync(join(shippedSkill, 'tools.json'), '{ "something": "this build ships" }\n');
    const stashSkill = join(home, 'knowledge', 'skills', 'install-optional-tool');
    mkdirSync(stashSkill, { recursive: true });
    writeFileSync(join(stashSkill, 'tools.json'), PREVIOUSLY_SHIPPED_TOOLS_JSON);
    try {
      delete process.env.OPENPALM_REPO_ROOT;
      process.env.OPENPALM_SKELETON_DIR = skeletonSrc;
      await applyHomeSeed(home);
      expect(existsSync(stashSkill)).toBe(false);
    } finally {
      rmSync(skeletonSrc, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Per FILE, and conjunctive: one recognised file does not license removing the
  // directory it sits in. This is the shape of a real edited skill — the seeded
  // tools.json untouched, the prose rewritten — and it must survive intact.
  test('keeps a whole skill when any one file in it is the operator\'s', async () => {
    const skeletonSrc = mkdtempSync(join(tmpdir(), 'openpalm-skeleton-skills-mixed-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-skills-mixed-'));
    mkdirSync(join(skeletonSrc, 'system', 'skills', 'install-optional-tool'), { recursive: true });
    writeFileSync(join(skeletonSrc, 'system', 'skills', 'install-optional-tool', 'SKILL.md'), 'shipped\n');
    const stashSkill = join(home, 'knowledge', 'skills', 'install-optional-tool');
    mkdirSync(stashSkill, { recursive: true });
    writeFileSync(join(stashSkill, 'tools.json'), PREVIOUSLY_SHIPPED_TOOLS_JSON);
    writeFileSync(join(stashSkill, 'SKILL.md'), 'my rewrite\n');
    try {
      delete process.env.OPENPALM_REPO_ROOT;
      process.env.OPENPALM_SKELETON_DIR = skeletonSrc;
      await applyHomeSeed(home);
      expect(readFileSync(join(stashSkill, 'SKILL.md'), 'utf8')).toBe('my rewrite\n');
      expect(existsSync(join(stashSkill, 'tools.json'))).toBe(true);
    } finally {
      rmSync(skeletonSrc, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The check deletes the directory on a `true`, so every shape it cannot read
  // as content has to answer `false`. A symlink is neither isFile() nor
  // isDirectory() to readdir, and a file-less tree lists nothing at all — both
  // used to leave `.every()` iterating an empty list, which is vacuously true,
  // and the operator's directory was removed on the strength of nothing having
  // been compared.
  test('keeps a stash skill holding a symlink, and never follows it', async () => {
    const skeletonSrc = mkdtempSync(join(tmpdir(), 'openpalm-skeleton-skills-link-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-skills-link-'));
    mkdirSync(join(skeletonSrc, 'system', 'skills', 'install-optional-tool'), { recursive: true });
    writeFileSync(join(skeletonSrc, 'system', 'skills', 'install-optional-tool', 'SKILL.md'), 'shipped\n');
    const target = join(home, 'my-skill.md');
    writeFileSync(target, 'mine\n');
    const stashSkill = join(home, 'knowledge', 'skills', 'install-optional-tool');
    mkdirSync(stashSkill, { recursive: true });
    symlinkSync(target, join(stashSkill, 'SKILL.md'));
    try {
      delete process.env.OPENPALM_REPO_ROOT;
      process.env.OPENPALM_SKELETON_DIR = skeletonSrc;
      await applyHomeSeed(home);
      expect(existsSync(join(stashSkill, 'SKILL.md'))).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('mine\n');
    } finally {
      rmSync(skeletonSrc, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('keeps a stash skill that holds no files at all', async () => {
    const skeletonSrc = mkdtempSync(join(tmpdir(), 'openpalm-skeleton-skills-bare-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-skills-bare-'));
    mkdirSync(join(skeletonSrc, 'system', 'skills', 'config-diagnostics'), { recursive: true });
    writeFileSync(join(skeletonSrc, 'system', 'skills', 'config-diagnostics', 'SKILL.md'), 'shipped\n');
    const stashSkill = join(home, 'knowledge', 'skills', 'config-diagnostics');
    mkdirSync(join(stashSkill, 'references'), { recursive: true });
    try {
      delete process.env.OPENPALM_REPO_ROOT;
      process.env.OPENPALM_SKELETON_DIR = skeletonSrc;
      await applyHomeSeed(home);
      expect(existsSync(join(stashSkill, 'references'))).toBe(true);
    } finally {
      rmSync(skeletonSrc, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The shipped side is read only after the stash side names the path, so this
  // build shipping a DIRECTORY where the stash holds a file used to throw an
  // uncaught EISDIR out of applyHomeSeed — aborting install/update, not just
  // this sweep.
  test('survives a stash file at a path this build ships as a directory', async () => {
    const skeletonSrc = mkdtempSync(join(tmpdir(), 'openpalm-skeleton-skills-eisdir-'));
    const home = mkdtempSync(join(tmpdir(), 'openpalm-home-skills-eisdir-'));
    const shippedSkill = join(skeletonSrc, 'system', 'skills', 'notify');
    mkdirSync(join(shippedSkill, 'examples'), { recursive: true });
    writeFileSync(join(shippedSkill, 'examples', 'usage.md'), 'shipped\n');
    const stashSkill = join(home, 'knowledge', 'skills', 'notify');
    mkdirSync(stashSkill, { recursive: true });
    writeFileSync(join(stashSkill, 'examples'), 'my notes\n');
    try {
      delete process.env.OPENPALM_REPO_ROOT;
      process.env.OPENPALM_SKELETON_DIR = skeletonSrc;
      await applyHomeSeed(home);
      expect(readFileSync(join(stashSkill, 'examples'), 'utf8')).toBe('my notes\n');
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
