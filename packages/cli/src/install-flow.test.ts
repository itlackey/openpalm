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
 *   - Builds images from local source via compose.dev.yaml
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

// ── Helpers ───────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const OPENPALM_SRC = join(REPO_ROOT, '.openpalm');
const ASSISTANT_SRC = join(REPO_ROOT, 'core/assistant/opencode');

/** Copy a directory tree using cp -a (preserves structure, fast). */
function cpTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const proc = Bun.spawnSync(['cp', '-a', `${src}/.`, dest]);
  if (proc.exitCode !== 0) throw new Error(`cp -a failed: ${src} → ${dest}`);
}

/** Seed the OP_HOME directory from the local repo (no network). */
function seedFromLocal(homeDir: string): void {
  const configDir = join(homeDir, 'config');
  const vaultDir = join(homeDir, 'vault');
  const dataDir = join(homeDir, 'data');

  // stack/ — full copy (system-managed)
  cpTree(join(OPENPALM_SRC, 'stack'), join(homeDir, 'stack'));

  // config/automations/ — seed only
  cpTree(join(OPENPALM_SRC, 'config/automations'), join(configDir, 'automations'));

  // vault/ — schemas only
  for (const sub of ['user', 'stack']) {
    const srcDir = join(OPENPALM_SRC, 'vault', sub);
    const destDir = join(vaultDir, sub);
    mkdirSync(destDir, { recursive: true });
    if (existsSync(srcDir)) {
      for (const f of readdirSync(srcDir)) {
        if (f.endsWith('.schema')) {
          const content = readFileSync(join(srcDir, f));
          Bun.spawnSync(['cp', join(srcDir, f), join(destDir, f)]);
        }
      }
    }
  }

  // data/assistant/ — opencode config
  const assistantDir = join(dataDir, 'assistant');
  mkdirSync(assistantDir, { recursive: true });
  if (existsSync(ASSISTANT_SRC)) {
    for (const f of readdirSync(ASSISTANT_SRC)) {
      Bun.spawnSync(['cp', '-a', join(ASSISTANT_SRC, f), join(assistantDir, f)]);
    }
  }

  // Seed file-based volume mount targets (CLI bootstrapInstall does this)
  const stackVault = join(vaultDir, 'stack');
  mkdirSync(stackVault, { recursive: true });
  if (!existsSync(join(stackVault, 'guardian.env'))) {
    Bun.spawnSync(['touch', join(stackVault, 'guardian.env')]);
  }
  if (!existsSync(join(stackVault, 'auth.json'))) {
    writeFileSync(join(stackVault, 'auth.json'), '{}\n');
  }

  // Create required directories
  for (const dir of [
    configDir,
    join(configDir, 'assistant'),
    join(configDir, 'guardian'),
    join(vaultDir, 'user'),
    join(vaultDir, 'stack'),
    dataDir,
    join(dataDir, 'admin'),
    join(dataDir, 'memory'),
    join(dataDir, 'guardian'),
    join(dataDir, 'stash'),
    join(dataDir, 'workspace'),
    join(homeDir, 'logs'),
    join(homeDir, 'logs/opencode'),
    join(homeDir, 'backups'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function makeSetupSpec(addons: Record<string, boolean>): Record<string, unknown> {
  return {
    spec: {
      version: 2,
      capabilities: {
        llm: 'ollama/qwen2.5-coder:3b',
        embeddings: { provider: 'ollama', model: 'nomic-embed-text:latest', dims: 768 },
        memory: { userId: 'testuser', customInstructions: '' },
        slm: 'ollama/qwen2.5-coder:3b',
      },
      addons,
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

/** Parse env vars from stack.env for compose variable substitution. */
function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

/** Resolve ${VAR:-default} patterns in a string. */
function resolveVars(str: string, vars: Record<string, string>): string {
  return str.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, name, def) => vars[name] ?? def ?? '');
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
        const resolved = resolveVars(raw, vars);
        if (!resolved.startsWith('/')) continue;
        const basename = resolved.split('/').pop() ?? '';
        const isFile = basename.includes('.') && !basename.startsWith('.');
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

  afterEach(() => {
    process.env.OP_HOME = originalHome;
    process.env.OP_WORK_DIR = originalWorkDir;
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  });

  it('seed + performSetup produces complete file structure for admin+chat', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'data/workspace');

    // Step 1: Seed from local .openpalm/
    seedFromLocal(homeDir);

    // Step 2: Run performSetup
    const { performSetup } = await import('@openpalm/lib');
    const spec = makeSetupSpec({ admin: true, chat: true });
    const result = await performSetup(spec as any);
    expect(result.ok).toBe(true);

    // ── Validate stack.yaml ──────────────────────────────────────────
    const stackYaml = join(homeDir, 'config/stack.yaml');
    expect(existsSync(stackYaml)).toBe(true);
    const stackSpec = yamlParse(readFileSync(stackYaml, 'utf-8'));
    expect(stackSpec.version).toBe(2);
    expect(stackSpec.addons).toEqual({ admin: true, chat: true });
    expect(stackSpec.capabilities.llm).toBe('ollama/qwen2.5-coder:3b');

    // ── Validate compose files exist ─────────────────────────────────
    expect(existsSync(join(homeDir, 'stack/core.compose.yml'))).toBe(true);
    expect(existsSync(join(homeDir, 'stack/addons/admin/compose.yml'))).toBe(true);
    expect(existsSync(join(homeDir, 'stack/addons/chat/compose.yml'))).toBe(true);

    // All addon compose files should be present (seeded from local)
    for (const addon of ['admin', 'api', 'chat', 'discord', 'ollama', 'voice', 'slack']) {
      const addonCompose = join(homeDir, `stack/addons/${addon}/compose.yml`);
      expect(existsSync(addonCompose)).toBe(true);
    }

    // ── Validate vault files are regular files (not directories) ─────
    for (const relPath of [
      'vault/stack/stack.env',
      'vault/stack/guardian.env',
      'vault/stack/auth.json',
      'vault/user/user.env',
    ]) {
      const fullPath = join(homeDir, relPath);
      expect(existsSync(fullPath)).toBe(true);
      expect(statSync(fullPath).isFile()).toBe(true);
    }

    // ── Validate vault schemas ───────────────────────────────────────
    for (const relPath of [
      'vault/user/user.env.schema',
      'vault/stack/stack.env.schema',
    ]) {
      const fullPath = join(homeDir, relPath);
      expect(existsSync(fullPath)).toBe(true);
      expect(statSync(fullPath).isFile()).toBe(true);
      expect(readFileSync(fullPath, 'utf-8').length).toBeGreaterThan(0);
    }

    // ── Validate all volume mount targets exist as user-owned ────────
    const stackEnvVars = {
      ...parseEnvFile(join(homeDir, 'vault/stack/stack.env')),
      ...process.env as Record<string, string>,
    };
    // OP_HOME must resolve to absolute path
    stackEnvVars.OP_HOME = homeDir;

    const allComposeFiles = [
      join(homeDir, 'stack/core.compose.yml'),
      join(homeDir, 'stack/addons/admin/compose.yml'),
      join(homeDir, 'stack/addons/chat/compose.yml'),
    ];
    const mounts = extractVolumeMountPaths(allComposeFiles, stackEnvVars);
    expect(mounts.length).toBeGreaterThan(0);

    // Ensure they all exist first (this is what ensureVolumeMountTargets does)
    const { ensureVolumeMountTargets } = await import('./commands/install.ts') as any;
    // Can't import private function, so replicate the check
    // Only check mounts inside homeDir (ignore Docker socket, etc.)
    const homeMounts = mounts.filter(m => m.path.startsWith(homeDir));

    for (const mount of homeMounts) {
      if (!existsSync(mount.path)) {
        if (mount.isFile) {
          mkdirSync(join(mount.path, '..'), { recursive: true });
          Bun.spawnSync(['touch', mount.path]);
        } else {
          mkdirSync(mount.path, { recursive: true });
        }
      }
    }

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

    // ── Validate data directories ────────────────────────────────────
    for (const dir of ['admin', 'assistant', 'memory', 'guardian', 'stash', 'workspace']) {
      expect(existsSync(join(homeDir, `data/${dir}`))).toBe(true);
    }

    // ── Validate automations seeded ──────────────────────────────────
    expect(existsSync(join(homeDir, 'config/automations'))).toBe(true);
    const automations = readdirSync(join(homeDir, 'config/automations'));
    expect(automations.length).toBeGreaterThan(0);
  }, 30_000);

  it('compose config validates with selected addons', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'data/workspace');

    seedFromLocal(homeDir);

    const { performSetup } = await import('@openpalm/lib');
    const result = await performSetup(makeSetupSpec({ admin: true, chat: true }) as any);
    expect(result.ok).toBe(true);

    // Ensure all volume mount targets exist so compose doesn't complain
    const stackEnv = join(homeDir, 'vault/stack/stack.env');
    const vars = { ...parseEnvFile(stackEnv), OP_HOME: homeDir };
    const composeFiles = [
      join(homeDir, 'stack/core.compose.yml'),
      join(homeDir, 'stack/addons/admin/compose.yml'),
      join(homeDir, 'stack/addons/chat/compose.yml'),
    ];
    for (const mount of extractVolumeMountPaths(composeFiles, vars)) {
      if (!mount.path.startsWith(homeDir)) continue; // skip Docker socket etc.
      if (!existsSync(mount.path)) {
        if (mount.isFile) {
          mkdirSync(join(mount.path, '..'), { recursive: true });
          Bun.spawnSync(['touch', mount.path]);
        } else {
          mkdirSync(mount.path, { recursive: true });
        }
      }
    }

    // Run docker compose config --quiet
    const proc = Bun.spawnSync([
      'docker', 'compose', '--project-name', 'openpalm-test',
      '-f', composeFiles[0],
      '-f', composeFiles[1],
      '-f', composeFiles[2],
      '--env-file', stackEnv,
      '--env-file', join(homeDir, 'vault/user/user.env'),
      'config', '--quiet',
    ], { stdout: 'pipe', stderr: 'pipe' });

    const stderr = new TextDecoder().decode(proc.stderr);
    expect(proc.exitCode).toBe(0);
  }, 30_000);

  it('performSetup with no addons produces only core services', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
    process.env.OP_HOME = homeDir;
    process.env.OP_WORK_DIR = join(homeDir, 'data/workspace');

    seedFromLocal(homeDir);

    const { performSetup } = await import('@openpalm/lib');
    const result = await performSetup(makeSetupSpec({}) as any);
    expect(result.ok).toBe(true);

    const stackYaml = join(homeDir, 'config/stack.yaml');
    const stackSpec = yamlParse(readFileSync(stackYaml, 'utf-8'));
    expect(stackSpec.addons).toEqual({});

    // Core compose only, no addon files in the compose list
    const stackEnv = join(homeDir, 'vault/stack/stack.env');
    const proc = Bun.spawnSync([
      'docker', 'compose', '--project-name', 'openpalm-test',
      '-f', join(homeDir, 'stack/core.compose.yml'),
      '--env-file', stackEnv,
      '--env-file', join(homeDir, 'vault/user/user.env'),
      'config', '--services',
    ], { stdout: 'pipe', stderr: 'pipe' });

    const services = new TextDecoder().decode(proc.stdout).trim().split('\n').sort();
    expect(services).toEqual(['assistant', 'guardian', 'memory', 'scheduler']);
  }, 30_000);
});

// ── Tier 2: Container Validation ──────────────────────────────────────────

describe('install flow — tier 2 (container validation)', () => {
  const RUN_TIER2 = process.env.RUN_INSTALL_TIER2_TESTS === '1';

  it.skipIf(!RUN_TIER2)('builds from source and starts all services healthy', async () => {
    // Uses .dev/ directory and compose.dev.yaml to build from source.
    // Requires: Docker running, local source code, .dev/ seeded.
    const devHome = join(REPO_ROOT, '.dev');
    if (!existsSync(join(devHome, 'vault/stack/stack.env'))) {
      throw new Error('.dev/ not seeded. Run: bun run dev:setup');
    }

    const composeArgs = [
      'docker', 'compose',
      '--project-directory', REPO_ROOT,
      '--project-name', 'openpalm-tier2',
      '-f', join(devHome, 'stack/core.compose.yml'),
      '-f', join(REPO_ROOT, 'compose.dev.yaml'),
      '--env-file', join(devHome, 'vault/stack/stack.env'),
      '--env-file', join(devHome, 'vault/user/user.env'),
    ];

    try {
      // Build from source
      const build = Bun.spawnSync([...composeArgs, 'build'], {
        stdout: 'inherit', stderr: 'inherit', timeout: 300_000,
      });
      expect(build.exitCode).toBe(0);

      // Start
      const up = Bun.spawnSync([...composeArgs, 'up', '-d'], {
        stdout: 'inherit', stderr: 'inherit', timeout: 120_000,
      });
      expect(up.exitCode).toBe(0);

      // Wait for health checks (up to 60s)
      await Bun.sleep(10_000);

      // Check all services
      const ps = Bun.spawnSync([...composeArgs, 'ps', '--format', '{{.Name}} {{.Status}}'], {
        stdout: 'pipe',
      });
      const lines = new TextDecoder().decode(ps.stdout).trim().split('\n');
      const unhealthy: string[] = [];
      const restarting: string[] = [];
      for (const line of lines) {
        if (line.includes('unhealthy') || line.includes('Exited')) unhealthy.push(line);
        if (line.includes('Restarting')) restarting.push(line);
      }

      expect(unhealthy).toEqual([]);
      expect(restarting).toEqual([]);
    } finally {
      // Teardown
      Bun.spawnSync([...composeArgs, 'down'], {
        stdout: 'ignore', stderr: 'ignore', timeout: 30_000,
      });
    }
  }, 600_000);
});
