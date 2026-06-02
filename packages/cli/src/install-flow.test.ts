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
const ASSISTANT_SRC = join(OPENPALM_SRC, 'config', 'assistant');
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
  const dataDir = join(homeDir, 'data');
  const stackDir = join(configDir, 'stack');

  // config/stack/ — seed fixed compose files
  mkdirSync(stackDir, { recursive: true });
  for (const name of ['core.compose.yml', 'services.compose.yml', 'channels.compose.yml', 'custom.compose.yml']) {
    Bun.spawnSync(['cp', join(OPENPALM_SRC, 'config', 'stack', name), join(stackDir, name)]);
  }

  if (enabledAddons.length > 0) {
    writeFileSync(join(stackDir, 'stack.yml'), `version: 2\naddons:\n${enabledAddons.map((addon) => `  - ${addon}`).join('\n')}\n`);
  }

  // knowledge/tasks/ — active AKM task files (populated by setup)
  cpTree(join(OPENPALM_SRC, 'knowledge', 'tasks'), join(homeDir, 'knowledge', 'tasks'));

  // config/assistant/ — opencode project config (opencode.jsonc, openpalm.md, system.md)
  // OPENCODE_CONFIG_DIR points at this directory inside the container.
  const assistantDir = join(configDir, 'assistant');
  mkdirSync(assistantDir, { recursive: true });
  if (existsSync(ASSISTANT_SRC)) {
    for (const f of readdirSync(ASSISTANT_SRC)) {
      Bun.spawnSync(['cp', '-a', join(ASSISTANT_SRC, f), join(assistantDir, f)]);
    }
  }

  // Seed file-based volume mount targets (CLI bootstrapInstall does this)
  mkdirSync(join(homeDir, 'knowledge', 'secrets'), { recursive: true });
  if (!existsSync(join(homeDir, 'knowledge', 'secrets', 'auth.json'))) {
    writeFileSync(join(homeDir, 'knowledge', 'secrets', 'auth.json'), '{}\n');
  }

  // Create required directories
  for (const dir of [
    configDir,
    join(configDir, 'assistant'),
    join(configDir, 'akm'),
    stackDir,
    dataDir,
    join(dataDir, 'assistant'),
    join(dataDir, 'admin'),
    join(dataDir, 'guardian'),
    join(dataDir, 'akm'),
    join(dataDir, 'akm/cache'),
    join(dataDir, 'akm/data'),
    join(dataDir, 'logs'),
    join(dataDir, 'backups'),
    join(dataDir, 'rollback'),
    join(homeDir, 'knowledge'),
    join(homeDir, 'knowledge', 'env'),
    join(homeDir, 'knowledge', 'secrets'),
    join(homeDir, 'workspace'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function makeSetupSpec(): Record<string, unknown> {
  return {
    version: 2,
    llm: { provider: 'ollama', model: 'qwen2.5-coder:3b', baseUrl: 'http://host.docker.internal:11434' },
    embedding: { provider: 'ollama', model: 'nomic-embed-text:latest', dims: 768, baseUrl: 'http://host.docker.internal:11434' },
    security: { uiLoginPassword: 'test-admin-token-12345' },
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

  tier1Test('seed + performSetup produces complete file structure for chat addon', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'workspace');

    // Step 1: Seed from local .openpalm/
    seedFromLocal(homeDir, ['chat']);

    // Step 2: Run performSetup
    const { performSetup } = await import('@openpalm/lib');
    const spec = makeSetupSpec();
    const result = await performSetup(spec as any);
    expect(result.ok).toBe(true);

    // ── Validate stack.yml via lib parser ─────────────────────────
    const stackSpec = readStackSpec(join(homeDir, 'config', 'stack'));
    expect(stackSpec).not.toBeNull();
    expect(stackSpec!.version).toBe(2);
    expect(stackSpec!.addons).toContain('chat');
    // LLM config lives in akm config.json.
    const akmConfigPath = join(homeDir, 'config/akm/config.json');
    expect(existsSync(akmConfigPath)).toBe(true);
    const akmConfig = JSON.parse(readFileSync(akmConfigPath, 'utf-8'));
    expect(akmConfig.llm?.provider).toBe('ollama');
    expect(akmConfig.llm?.model).toBe('qwen2.5-coder:3b');

    // ── Validate compose files exist ─────────────────────────────────
    expect(existsSync(join(homeDir, 'config/stack/core.compose.yml'))).toBe(true);
    expect(existsSync(join(homeDir, 'config/stack/services.compose.yml'))).toBe(true);
    expect(existsSync(join(homeDir, 'config/stack/channels.compose.yml'))).toBe(true);
    expect(existsSync(join(homeDir, 'config/stack/custom.compose.yml'))).toBe(true);
    expect(readFileSync(join(homeDir, 'config/stack/stack.yml'), 'utf-8')).toContain('- chat');

    // ── Validate env/secret files are regular files (not directories) ─
    // Note: user-managed env config lives in the akm env:user file
    // (knowledge/env/user.env) and the assistant entrypoint sources it
    // directly. It is never passed to Compose as an env_file.
    for (const relPath of [
      'knowledge/env/stack.env',
      'knowledge/secrets/auth.json',
    ]) {
      const fullPath = join(homeDir, relPath);
      expect(existsSync(fullPath)).toBe(true);
      expect(statSync(fullPath).isFile()).toBe(true);
    }
    expect(existsSync(join(homeDir, 'config/stack/guardian.env'))).toBe(false);

    // ── Validate all volume mount targets exist as user-owned ────────
    const stackEnvVars = {
      ...parseEnvFile(join(homeDir, 'knowledge/env/stack.env')),
      ...process.env as Record<string, string>,
    };
    // OP_HOME must resolve to absolute path
    stackEnvVars.OP_HOME = homeDir;

    const allComposeFiles = [
      join(homeDir, 'config/stack/core.compose.yml'),
      join(homeDir, 'config/stack/services.compose.yml'),
      join(homeDir, 'config/stack/channels.compose.yml'),
      join(homeDir, 'config/stack/custom.compose.yml'),
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

    // ── Validate data and stash directories ─────────────────────────────────────
    for (const dir of ['data/admin', 'data/assistant', 'data/guardian', 'knowledge', 'workspace']) {
      expect(existsSync(join(homeDir, dir))).toBe(true);
    }

    // ── Validate akm-improve is seeded into knowledge/tasks/ ──
    // Tasks are AKM-owned stash files. performSetup preserves user edits.
    const tasksDir = join(homeDir, 'knowledge/tasks');
    expect(existsSync(tasksDir)).toBe(true);
    const tasks = readdirSync(tasksDir).sort();
    expect(tasks).toContain('akm-improve.yml');

    const akmImprovePath = join(homeDir, 'knowledge/tasks/akm-improve.yml');
    const akmImproveContent = readFileSync(akmImprovePath, 'utf-8');
    expect(akmImproveContent).toContain('akm');
    expect(akmImproveContent).toContain('improve');
    // Confirm we're on the 0.8.0+ command, not the removed `index --enrich`.
    expect(akmImproveContent).not.toMatch(/--enrich\b/);

    // ── Re-run setup: user edits to akm-improve.yml must survive ─────
    const userEdited = 'schedule: "0 9 * * *"\nenabled: false\ncommand: ["akm","improve","--auto-accept","safe"]\n';
    writeFileSync(akmImprovePath, userEdited);
    const reSetup = await performSetup(spec as any);
    expect(reSetup.ok).toBe(true);
    expect(readFileSync(akmImprovePath, 'utf-8')).toBe(userEdited);
  }, 30_000);

  tier1Test('compose config validates with selected addons', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'workspace');

    seedFromLocal(homeDir, ['chat']);

    const { performSetup } = await import('@openpalm/lib');
    const result = await performSetup(makeSetupSpec() as any);
    expect(result.ok).toBe(true);

    // Ensure all volume mount targets exist so compose doesn't complain
    const stackEnv = join(homeDir, 'knowledge/env/stack.env');
    const composeFiles = [
      join(homeDir, 'config/stack/core.compose.yml'),
      join(homeDir, 'config/stack/services.compose.yml'),
      join(homeDir, 'config/stack/channels.compose.yml'),
      join(homeDir, 'config/stack/custom.compose.yml'),
    ];
    const { ensureComposeVolumeTargets, createState } = await import('@openpalm/lib');
    ensureComposeVolumeTargets(createState());

    // Run docker compose config --quiet
    // Note: vault/user/user.env and legacy guardian.env are no longer compose env_files.
    const proc = Bun.spawnSync([
      'docker', 'compose', '--project-name', 'openpalm-test',
      '-f', composeFiles[0],
      '-f', composeFiles[1],
      '-f', composeFiles[2],
      '-f', composeFiles[3],
      '--env-file', stackEnv,
      '--profile', 'addon.chat',
      'config', '--quiet',
    ], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OP_HOME: homeDir } });

    const stderr = new TextDecoder().decode(proc.stderr);
    if (proc.exitCode !== 0) {
      throw new Error(`docker compose config failed (exit ${proc.exitCode}):\n${stderr}`);
    }
    expect(proc.exitCode).toBe(0);
  }, 30_000);

  tier1Test('seedOpenPalmDir copies the built-in stash skill on first install', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'workspace');

    const { seedOpenPalmDir } = await import('./lib/io.ts');
    await seedOpenPalmDir('local', homeDir, join(homeDir, 'config'), join(homeDir, 'data'));

    // The shipped config-diagnostics skill must land on disk with valid frontmatter.
    const skillPath = join(homeDir, 'knowledge/skills/config-diagnostics/SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('name: config-diagnostics');
    expect(skill).toContain('type: skill');
    expect(skill.startsWith('---')).toBe(true);
  }, 30_000);

  tier1Test('seedOpenPalmDir preserves user edits to seeded stash assets', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'workspace');

    const { seedOpenPalmDir } = await import('./lib/io.ts');

    // First install seeds the asset.
    await seedOpenPalmDir('local', homeDir, join(homeDir, 'config'), join(homeDir, 'data'));
    const skillPath = join(homeDir, 'knowledge/skills/config-diagnostics/SKILL.md');
    expect(existsSync(skillPath)).toBe(true);

    // User edits the seeded skill.
    const userEdit = '# User-edited skill — do not clobber\n';
    writeFileSync(skillPath, userEdit);

    // Re-install must not overwrite the user's edit (skipExisting).
    await seedOpenPalmDir('local', homeDir, join(homeDir, 'config'), join(homeDir, 'data'));
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
    // Only knowledge/env/stack.env is needed for `compose config`.
    const stackEnv = join(homeDir, 'knowledge/env/stack.env');
    const proc = Bun.spawnSync([
      'docker', 'compose', '--project-name', 'openpalm-test',
      '-f', join(homeDir, 'config/stack/core.compose.yml'),
      '--env-file', stackEnv,
      'config', '--services',
    ], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OP_HOME: homeDir } });

    const services = new TextDecoder().decode(proc.stdout).trim().split('\n').sort();
    expect(services).toEqual(['assistant']);
  }, 30_000);
});

// Container validation (builds from source, starts services, verifies health)
// is covered by Tier 6: ./scripts/dev-e2e-test.sh
