/**
 * Install flow validation tests.
 *
 * Tier 1: File structure validation (no Docker containers, fast).
 *   - Seeds from LOCAL .openpalm/ directory (no GitHub fetch)
 *   - Runs performSetup with a realistic SetupSpec
 *   - Validates every file, directory, and permission the install should produce
 *   - Validates compose config with `docker compose config --quiet`
 *
 * Tier 2: Container validation (needs Docker, builds from source).
 *   - Builds images from local source via compose.dev.yml
 *   - Starts the stack
 *   - Validates every expected container is running and healthy
 */
import { describe, expect, it, afterEach } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
  readFileSync, statSync, readdirSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { readStackSpec, parseEnvFile, expandEnvVars } from '@openpalm/lib';

// ── Helpers ───────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const OPENPALM_SRC = join(REPO_ROOT, '.openpalm');
const ASSISTANT_SRC = join(REPO_ROOT, 'core/assistant/opencode');
const SKIP_INSTALL_FLOW_IN_CI = process.env.CI === 'true';

/** Copy a directory tree using cp -a (preserves structure, fast). */
function cpTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const proc = Bun.spawnSync(['cp', '-a', `${src}/.`, dest]);
  if (proc.exitCode !== 0) throw new Error(`cp -a failed: ${src} → ${dest}`);
}

/** Seed the OP_HOME directory from the local repo (no network). */
function seedFromLocal(homeDir: string, enabledAddons: string[] = []): void {
  const configDir = join(homeDir, 'config');
  const stateDir = join(homeDir, 'state');
  const stackDir = join(configDir, 'stack');

  // config/stack/ — seed core compose only
  mkdirSync(stackDir, { recursive: true });
  Bun.spawnSync(['cp', join(OPENPALM_SRC, 'stack', 'core.compose.yml'), join(stackDir, 'core.compose.yml')]);

  // state/registry/ — shipped catalog source
  cpTree(join(OPENPALM_SRC, 'registry', 'addons'), join(stateDir, 'registry', 'addons'));
  cpTree(join(OPENPALM_SRC, 'registry', 'automations'), join(stateDir, 'registry', 'automations'));

  // config/stack/addons/ — enabled runtime overlays only
  for (const addon of enabledAddons) {
    cpTree(join(OPENPALM_SRC, 'registry', 'addons', addon), join(stackDir, 'addons', addon));
  }

  // stash/tasks/ — active AKM task files (populated by setup)
  mkdirSync(join(homeDir, 'stash', 'tasks'), { recursive: true });

  // state/assistant/ — opencode config
  const assistantDir = join(stateDir, 'assistant');
  mkdirSync(assistantDir, { recursive: true });
  if (existsSync(ASSISTANT_SRC)) {
    for (const f of readdirSync(ASSISTANT_SRC)) {
      Bun.spawnSync(['cp', '-a', join(ASSISTANT_SRC, f), join(assistantDir, f)]);
    }
  }

  // Seed file-based volume mount targets (CLI bootstrapInstall does this)
  mkdirSync(stackDir, { recursive: true });
  if (!existsSync(join(stackDir, 'guardian.env'))) {
    Bun.spawnSync(['touch', join(stackDir, 'guardian.env')]);
  }
  if (!existsSync(join(configDir, 'auth.json'))) {
    writeFileSync(join(configDir, 'auth.json'), '{}\n');
  }

  // Create required directories
  for (const dir of [
    configDir,
    join(configDir, 'assistant'),
    join(configDir, 'akm'),
    stackDir,
    join(stackDir, 'addons'),
    stateDir,
    join(stateDir, 'assistant'),
    join(stateDir, 'admin'),
    join(stateDir, 'guardian'),
    join(homeDir, 'stash'),
    join(homeDir, 'workspace'),
    join(homeDir, 'cache'),
    join(homeDir, 'cache', 'akm'),
    join(stateDir, 'logs'),
    join(stateDir, 'logs', 'opencode'),
    join(stateDir, 'backups'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function makeSetupSpec(): Record<string, unknown> {
  return {
    version: 2,
    capabilities: {
      llm: 'ollama/qwen2.5-coder:3b',
      embeddings: { provider: 'ollama', model: 'nomic-embed-text:latest', dims: 768 },
      slm: 'ollama/qwen2.5-coder:3b',
    },
    security: { adminToken: 'test-admin-token-12345' },
    owner: { name: 'Test', email: 'test@test.com' },
    connections: [{
      id: 'ollama',
      name: 'Ollama',
      provider: 'ollama',
      baseUrl: 'http://host.docker.internal:11434',
      apiKey: '',
    }],
  };
}

/** Extract all host-side volume mount paths from compose files. */
function extractVolumeMountPaths(
  composeFiles: string[],
  vars: Record<string, string>,
): { path: string; isFile: boolean }[] {
  const results: { path: string; isFile: boolean }[] = [];
  for (const file of composeFiles) {
    if (!existsSync(file)) continue;
    let doc: any;
    try { doc = yamlParse(readFileSync(file, 'utf-8')); } catch { continue; }
    if (!doc?.services) continue;
    for (const svc of Object.values(doc.services) as any[]) {
      if (!Array.isArray(svc?.volumes)) continue;
      for (const vol of svc.volumes) {
        const raw = typeof vol === 'string' ? vol.split(':')[0] : (vol?.source ?? '');
        if (!raw || typeof raw !== 'string') continue;
        const resolved = expandEnvVars(raw, vars);
        if (!resolved.startsWith('/')) continue;
        const basename = resolved.split('/').pop() ?? '';
        const isFile = basename.includes('.');
        results.push({ path: resolved, isFile });
      }
    }
  }
  return results;
}

// ── Tier 1: File Structure Validation ─────────────────────────────────────

describe('install flow — tier 1 (file validation)', () => {
  let homeDir: string;
  const originalHome = process.env.OP_HOME;
  const originalWorkDir = process.env.OP_WORK_DIR;
  const tier1Test = SKIP_INSTALL_FLOW_IN_CI ? it.skip : it;

  afterEach(() => {
    process.env.OP_HOME = originalHome;
    process.env.OP_WORK_DIR = originalWorkDir;
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  });

  tier1Test('seed + performSetup produces complete file structure for admin+chat', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'workspace');

    // Step 1: Seed from local .openpalm/
    seedFromLocal(homeDir, ['admin', 'chat']);

    // Step 2: Run performSetup
    const { performSetup } = await import('@openpalm/lib');
    const spec = makeSetupSpec();
    const result = await performSetup(spec as any);
    expect(result.ok).toBe(true);

    // ── Validate stack.yml via lib parser ─────────────────────────
    const configDir = join(homeDir, 'config');
    const stackSpec = readStackSpec(join(homeDir, 'config', 'stack'));
    expect(stackSpec).not.toBeNull();
    expect(stackSpec!.version).toBe(2);
    expect(stackSpec!.capabilities.llm).toBe('ollama/qwen2.5-coder:3b');

    // ── Validate compose files exist ─────────────────────────────────
    expect(existsSync(join(homeDir, 'config/stack/core.compose.yml'))).toBe(true);
    expect(existsSync(join(homeDir, 'config/stack/addons/admin/compose.yml'))).toBe(true);
    expect(existsSync(join(homeDir, 'config/stack/addons/chat/compose.yml'))).toBe(true);

    expect(existsSync(join(homeDir, 'state/registry/addons/admin/compose.yml'))).toBe(true);
    expect(existsSync(join(homeDir, 'state/registry/addons/chat/compose.yml'))).toBe(true);
    expect(existsSync(join(homeDir, 'state/registry/automations/cleanup-logs.md'))).toBe(true);

    // ── Validate vault files are regular files (not directories) ─────
    // Phase 2 of #388 (closes #406): vault/user/user.env is no longer
    // seeded — user-managed env secrets live in akm vault:user
    // (data/stash/vaults/user.env) and the assistant entrypoint sources
    // it directly. The compose env_file mount for vault/user/user.env
    // has been removed too.
    for (const relPath of [
      'config/stack/stack.env',
      'config/stack/guardian.env',
      'config/auth.json',
    ]) {
      const fullPath = join(homeDir, relPath);
      expect(existsSync(fullPath)).toBe(true);
      expect(statSync(fullPath).isFile()).toBe(true);
    }

    // ── Validate all volume mount targets exist as user-owned ────────
    const stackEnvVars = {
      ...parseEnvFile(join(homeDir, 'config/stack/stack.env')),
      ...process.env as Record<string, string>,
    };
    // OP_HOME must resolve to absolute path
    stackEnvVars.OP_HOME = homeDir;

    const allComposeFiles = [
      join(homeDir, 'config/stack/core.compose.yml'),
      join(homeDir, 'config/stack/addons/admin/compose.yml'),
      join(homeDir, 'config/stack/addons/chat/compose.yml'),
    ];
    const mounts = extractVolumeMountPaths(allComposeFiles, stackEnvVars);
    expect(mounts.length).toBeGreaterThan(0);

    // Ensure they all exist first via the canonical lib helper. Only mounts
    // under homeDir are touched; external paths (Docker socket, etc.) are left
    // alone by ensureComposeVolumeTargets itself, but we also filter the
    // verification loop below to homeDir to keep the assertion local.
    const { ensureComposeVolumeTargets, createState } = await import('@openpalm/lib');
    ensureComposeVolumeTargets(createState());
    const homeMounts = mounts.filter(m => m.path.startsWith(homeDir));

    for (const mount of homeMounts) {
      expect(existsSync(mount.path)).toBe(true);
      const stat = lstatSync(mount.path);
      if (mount.isFile) {
        expect(stat.isFile()).toBe(true);
      } else {
        expect(stat.isDirectory()).toBe(true);
      }
      // Must be owned by current user, not root
      expect(stat.uid).toBe(process.getuid!());
    }

    // ── Validate no root-owned files ─────────────────────────────────
    const rootOwned = Bun.spawnSync(['find', homeDir, '-user', 'root'], { stdout: 'pipe' });
    const rootFiles = new TextDecoder().decode(rootOwned.stdout).trim();
    expect(rootFiles).toBe('');

    // ── Validate state and stash directories ────────────────────────────────────
    for (const dir of ['state/admin', 'state/assistant', 'state/guardian', 'stash', 'workspace']) {
      expect(existsSync(join(homeDir, dir))).toBe(true);
    }

    // ── Validate akm-improve is seeded into stash/tasks/ ──
    // performSetup seeds the akm-improve maintenance automation on first
    // install as an AKM markdown task; everything else stays in the registry
    // catalog until enabled.
    const tasksDir = join(homeDir, 'stash/tasks');
    expect(existsSync(tasksDir)).toBe(true);
    const tasks = readdirSync(tasksDir).sort();
    expect(tasks).toEqual(['akm-improve.md']);

    const akmImprovePath = join(homeDir, 'stash/tasks/akm-improve.md');
    const akmImproveContent = readFileSync(akmImprovePath, 'utf-8');
    expect(akmImproveContent).toContain('akm');
    expect(akmImproveContent).toContain('improve');
    // Confirm we're on the 0.8.0+ command, not the removed `index --enrich`.
    expect(akmImproveContent).not.toMatch(/--enrich\b/);

    // ── Re-run setup: user edits to akm-improve.md must survive ─────
    const userEdited = '---\nschedule: "0 9 * * *"\nenabled: false\ncommand: ["akm","improve","--auto-accept","safe"]\n---\n';
    writeFileSync(akmImprovePath, userEdited);
    const reSetup = await performSetup(spec as any);
    expect(reSetup.ok).toBe(true);
    expect(readFileSync(akmImprovePath, 'utf-8')).toBe(userEdited);
  }, 30_000);

  tier1Test('compose config validates with selected addons', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'workspace');

    seedFromLocal(homeDir, ['admin', 'chat']);

    const { performSetup } = await import('@openpalm/lib');
    const result = await performSetup(makeSetupSpec() as any);
    expect(result.ok).toBe(true);

    // Ensure all volume mount targets exist so compose doesn't complain
    const stackEnv = join(homeDir, 'config/stack/stack.env');
    const composeFiles = [
      join(homeDir, 'config/stack/core.compose.yml'),
      join(homeDir, 'config/stack/addons/admin/compose.yml'),
      join(homeDir, 'config/stack/addons/chat/compose.yml'),
    ];
    const { ensureComposeVolumeTargets, createState } = await import('@openpalm/lib');
    ensureComposeVolumeTargets(createState());

    // Run docker compose config --quiet
    // Phase 2 of #388 (closes #406): vault/user/user.env is no longer a
    // compose env_file. Only stack.env (and guardian.env, when present)
    // are passed to compose.
    const proc = Bun.spawnSync([
      'docker', 'compose', '--project-name', 'openpalm-test',
      '-f', composeFiles[0],
      '-f', composeFiles[1],
      '-f', composeFiles[2],
      '--env-file', stackEnv,
      'config', '--quiet',
    ], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OP_HOME: homeDir } });

    const stderr = new TextDecoder().decode(proc.stderr);
    if (proc.exitCode !== 0) {
      throw new Error(`docker compose config failed (exit ${proc.exitCode}):\n${stderr}`);
    }
    expect(proc.exitCode).toBe(0);
  }, 30_000);

  tier1Test('seedEmbeddedAssets copies built-in stash skills on first install', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'workspace');

    // Pre-create the data/stash dir the way ensureHomeDirs() does, so the
    // seeder lands in a realistic OP_HOME shape.
    mkdirSync(join(homeDir, 'stash'), { recursive: true });

    const { seedEmbeddedAssets, EMBEDDED_STASH_SEEDS } = await import('./lib/embedded-assets.ts');

    // Every embedded seed must land on disk with non-empty content and a
    // YAML frontmatter intro — proves the Bun text import survived the
    // build and `seedEmbeddedAssets` wired the seeder up correctly.
    seedEmbeddedAssets(homeDir);

    for (const relPath of Object.keys(EMBEDDED_STASH_SEEDS)) {
      const seeded = join(homeDir, 'stash', relPath);
      expect(existsSync(seeded)).toBe(true);
      const content = readFileSync(seeded, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
      expect(content.startsWith('---')).toBe(true);
    }

    // The system prompt references this specific skill — assert both
    // file existence AND content shape so we know the install actually
    // ran seedEmbeddedAssets end-to-end (not just created the dir).
    const skillPath = join(homeDir, 'stash/skills/config-diagnostics/SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('name: config-diagnostics');
    expect(skill).toContain('type: skill');
    // Body must exist after the closing frontmatter delimiter.
    const frontmatterEnd = skill.indexOf('\n---', 3);
    expect(frontmatterEnd).toBeGreaterThan(0);
    expect(skill.slice(frontmatterEnd + 4).trim().length).toBeGreaterThan(0);
  }, 30_000);

  tier1Test('seedEmbeddedAssets preserves user edits to seeded stash assets', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'workspace');
    mkdirSync(join(homeDir, 'stash'), { recursive: true });

    const { seedEmbeddedAssets } = await import('./lib/embedded-assets.ts');

    // First install seeds the asset.
    seedEmbeddedAssets(homeDir);
    const skillPath = join(homeDir, 'stash/skills/config-diagnostics/SKILL.md');
    expect(existsSync(skillPath)).toBe(true);

    // User edits the seeded skill.
    const userEdit = '# User-edited skill — do not clobber\n';
    writeFileSync(skillPath, userEdit);

    // Re-install (e.g. `openpalm install` on an existing OP_HOME) must
    // not overwrite the user's edit.
    seedEmbeddedAssets(homeDir);
    expect(readFileSync(skillPath, 'utf-8')).toBe(userEdit);
  }, 30_000);

  tier1Test('performSetup with no addons produces only core services', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'workspace');

    seedFromLocal(homeDir);

    const { performSetup } = await import('@openpalm/lib');
    const result = await performSetup(makeSetupSpec() as any);
    expect(result.ok).toBe(true);

    const noAddonSpec = readStackSpec(join(homeDir, 'config', 'stack'));
    expect(noAddonSpec).not.toBeNull();

    // Core compose only, no addon files in the compose list.
    // Only state/stack.env is needed for `compose config`.
    const stackEnv = join(homeDir, 'config/stack/stack.env');
    const proc = Bun.spawnSync([
      'docker', 'compose', '--project-name', 'openpalm-test',
      '-f', join(homeDir, 'config/stack/core.compose.yml'),
      '--env-file', stackEnv,
      'config', '--services',
    ], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OP_HOME: homeDir } });

    const services = new TextDecoder().decode(proc.stdout).trim().split('\n').sort();
    expect(services).toEqual(['assistant', 'guardian', 'init']);
  }, 30_000);
});

// Container validation (builds from source, starts services, verifies health)
// is covered by Tier 6: ./scripts/dev-e2e-test.sh
