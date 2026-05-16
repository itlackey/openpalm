import { defineCommand } from 'citty';
import { join } from 'node:path';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultWorkDir } from '../lib/paths.ts';
import { resolveOpenPalmHome, resolveConfigDir } from '@openpalm/lib';
import { ensureSecrets, ensureStackEnv } from '../lib/env.ts';
import { ensureDirectoryTree, seedOpenPalmDir } from '../lib/io.ts';
import { openBrowser } from '../lib/browser.ts';
import { runDockerCompose, runDockerComposeCapture } from '../lib/docker.ts';
import {
  backupOpenPalmHome,
  buildComposeCliArgs,
  ensureOpenCodeConfig, ensureOpenCodeSystemConfig,
  performSetup,
  applyInstall,
  buildManagedServices,
  createOpenCodeClient,
  createLogger,
  resolveRequestedImageTag,
  type SetupSpec,
} from '@openpalm/lib';
import { seedEmbeddedAssets } from '../lib/embedded-assets.ts';
import { detectHostInfo } from '../lib/host-info.ts';
import { ensureValidState } from '../lib/cli-state.ts';
import { createSetupServer } from '../setup-wizard/server.ts';
import { startOpenCodeSubprocess, type OpenCodeSubprocess } from '../lib/opencode-subprocess.ts';

const logger = createLogger('cli:install');
const SETUP_WIZARD_PORT = Number(process.env.OP_SETUP_PORT) || 0; // 0 = random available port

async function resolveDefaultInstallRef(): Promise<string> {
  try {
    const res = await fetch('https://github.com/itlackey/openpalm/releases/latest', { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const match = (res.headers.get('location') ?? '').match(/\/tag\/(v[0-9]+\.[0-9]+\.[0-9]+[^\s]*)$/);
    if (match?.[1]) return match[1];
  } catch { /* fall through */ }
  return cliPkg.version ? `v${cliPkg.version}` : 'main';
}

export default defineCommand({
  meta: {
    name: 'install',
    description: 'Bootstrap home dirs, download assets, run setup wizard, start core services',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Skip "already installed" check',
      default: false,
    },
    version: {
      type: 'string',
      description: 'Install specific repository ref (default: latest release)',
    },
    start: {
      type: 'boolean',
      description: 'Start services after install (use --no-start to skip)',
      default: true,
    },
    open: {
      type: 'boolean',
      description: 'Open browser after install (use --no-open to skip)',
      default: true,
    },
    file: {
      type: 'string',
      alias: 'f',
      description: 'Path to setup config file (JSON or YAML) — skips wizard',
    },
    'admin-mode': {
      type: 'string',
      description: 'Admin server mode: "host" or "container" (default: host)',
      default: 'host',
      // TODO(phase-3): remove container mode entirely
    },
  },
  async run({ args }) {
    try {
      const version = args.version || await resolveDefaultInstallRef();
      await bootstrapInstall({
        force: args.force,
        version,
        noStart: !args.start,
        noOpen: !args.open,
        file: args.file,
        adminMode: (args['admin-mode'] === 'host' ? 'host' : 'container'),
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  },
});

type InstallOptions = {
  force: boolean;
  version: string;
  noStart: boolean;
  noOpen: boolean;
  file?: string;
  adminMode: 'host' | 'container';
};

async function requireCmd(cmd: string[], msg: string): Promise<void> {
  if ((await Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }).exited) !== 0) throw new Error(msg);
}

async function requireDocker(): Promise<void> {
  if (!Bun.which('docker')) throw new Error('Docker is not installed. Install Docker first: https://docs.docker.com/get-docker/');
  await requireCmd(['docker', 'info'], 'Docker is not running (or current user lacks permission). Start Docker and retry.');
  await requireCmd(['docker', 'compose', 'version'], 'Docker Compose v2 is required. Install it: https://docs.docker.com/compose/install/');
}

async function deployServices(mode: string, pull = true): Promise<string[]> {
  const state = ensureValidState();
  await applyInstall(state);
  const managedServices = await buildManagedServices(state);
  const composeArgs = buildComposeCliArgs(state);
  if (pull) await runDockerCompose([...composeArgs, 'pull', ...managedServices]).catch(() => console.warn('Warning: image pull failed.'));
  await runDockerCompose([...composeArgs, 'up', '-d', ...managedServices]);
  console.log(JSON.stringify({ ok: true, mode, services: managedServices }, null, 2));
  return managedServices;
}

async function parseConfigFile(filePath: string, raw: string): Promise<Record<string, unknown>> {
  const ext = filePath.toLowerCase();
  const isYaml = ext.endsWith('.yaml') || ext.endsWith('.yml');
  if (!isYaml && !ext.endsWith('.json')) throw new Error(`Unsupported config file format: ${filePath}. Use .json or .yaml.`);
  try {
    return isYaml ? (await import('yaml')).parse(raw) : JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse setup config '${filePath}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function bootstrapInstall(options: InstallOptions): Promise<void> {
  const homeDir = resolveOpenPalmHome();
  const configDir = resolveConfigDir();
  const stateDir = `${homeDir}/state`;
  const workDir = defaultWorkDir();

  // Use config/stack/stack.env (always present after a successful install) as the
  // canonical "already installed" indicator.
  const alreadyInstalled = await Bun.file(join(configDir, 'stack', 'stack.env')).exists();
  if (alreadyInstalled && !options.force) {
    throw new Error('OpenPalm appears to already be installed. Re-run install with --force to continue.');
  }

  if (alreadyInstalled && options.force) {
    const backupDir = backupOpenPalmHome(homeDir);
    if (backupDir) {
      console.log(`Backed up existing OP_HOME to ${backupDir}`);
    }
  }

  // ── Bootstrap files ────────────────────────────────────────────────────
  await prepareInstallFiles(homeDir, configDir, stateDir, workDir, options.version);

  // Write admin mode preference to stack.env (append if not present)
  if (options.adminMode === 'host') {
    const stackEnvPath = join(configDir, 'stack', 'stack.env');
    const existing = await Bun.file(stackEnvPath).text().catch(() => '');
    if (!existing.includes('OPENPALM_ADMIN_MODE=')) {
      await Bun.write(stackEnvPath, existing.trimEnd() + '\nOPENPALM_ADMIN_MODE=host\n');
    }
  }

  // ── Configure ──────────────────────────────────────────────────────────
  // File-based install: read config, run performSetup, optionally deploy
  if (options.file) {
    await runFileInstall(options.file, options.noStart);
    return;
  }

  // Interactive wizard: --force always runs wizard, otherwise only on first install
  const needsWizard = !alreadyInstalled || options.force;
  if (needsWizard) {
    await runWizardInstall(configDir, options.noOpen, options.noStart);
    return;
  }

  // Update mode (already installed, no --force): just redeploy
  if (options.noStart) {
    console.log('Config updated. Run `openpalm start` to start services.');
    return;
  }
  await requireDocker();
  await deployServices('update', false);
}

async function prepareInstallFiles(
  homeDir: string, configDir: string, stateDir: string, workDir: string, version: string,
): Promise<void> {
  console.log('Preparing directories...');
  await ensureDirectoryTree(homeDir, configDir, '', '', workDir);

  try { await Bun.write(join(stateDir, 'host.json'), JSON.stringify(await detectHostInfo(), null, 2) + '\n'); }
  catch (err) { logger.debug('failed to write host.json', { error: String(err) }); }

  // Seed core files from embedded assets (always available, even offline)
  seedEmbeddedAssets(homeDir);

  // Try to fetch latest assets from GitHub (non-fatal — embedded assets are sufficient)
  try {
    await seedOpenPalmDir(version, homeDir, configDir, stateDir);
  } catch (err) {
    logger.debug('seedOpenPalmDir failed (embedded assets already seeded)', { error: String(err) });
  }

  console.log('Configuring secrets...');
  await ensureSecrets(stateDir);
  await ensureStackEnv(homeDir, configDir, workDir, version, resolveRequestedImageTag(version) ?? undefined);

  for (const [path, content] of [
    [join(configDir, 'stack', 'guardian.env'), '# Guardian channel HMAC secrets — managed by openpalm\n'],
    [join(configDir, 'stack', 'auth.json'), '{}\n'],
  ] as const) {
    if (!(await Bun.file(path).exists())) await Bun.write(path, content);
  }

  try { ensureOpenCodeConfig(); ensureOpenCodeSystemConfig(); } catch (err) { logger.debug('failed to ensure OpenCode config', { error: String(err) }); }
}

async function runWizardInstall(configDir: string, noOpen: boolean, noStart = false): Promise<void> {
  console.log('Starting setup wizard...');

  // Start OpenCode subprocess for provider discovery (non-fatal if unavailable)
  let openCodeSub: OpenCodeSubprocess | null = null;
  let openCodeClient: ReturnType<typeof createOpenCodeClient> | undefined;
  try {
    console.log('Starting provider discovery...');
    openCodeSub = await startOpenCodeSubprocess({
      homeDir: resolveOpenPalmHome(),
      configDir: resolveConfigDir(),
      stateDir: `${resolveOpenPalmHome()}/state`,
    });
    const ready = await openCodeSub.waitForReady();
    if (ready) {
      openCodeClient = createOpenCodeClient({ baseUrl: openCodeSub.baseUrl });
    } else {
      console.log('Provider discovery unavailable. Using built-in provider list.');
      await openCodeSub.stop();
      openCodeSub = null;
    }
  } catch {
    console.log('Provider discovery unavailable. Using built-in provider list.');
    openCodeSub = null;
  }

  const wizard = createSetupServer(SETUP_WIZARD_PORT, { configDir, openCodeClient });
  const wizardUrl = `http://localhost:${wizard.server.port}/setup`;
  console.log(`Setup wizard running at ${wizardUrl}`);
  if (!noOpen) await openBrowser(wizardUrl);

  const result = await wizard.waitForComplete();
  if (!result.ok) { wizard.stop(); throw new Error(`Setup failed: ${result.error ?? 'unknown error'}`); }

  if (noStart) {
    console.log('Setup complete. Config written. Run `openpalm start` to start services.');
    wizard.stop();
    if (openCodeSub) await openCodeSub.stop().catch(() => {});
    return;
  }

  console.log('Setup complete. Checking Docker...');
  wizard.setDeploying(true);
  await requireDocker();

  console.log('Starting services...');
  const state = ensureValidState();
  await applyInstall(state);
  const allServices = await buildManagedServices(state);
  const composeArgs = buildComposeCliArgs(state);
  try {
    wizard.updateDeployStatus(allServices.map(service => ({ service, status: 'pending', label: 'Pulling images...' })));
    await runDockerCompose([...composeArgs, 'pull', ...allServices]).catch(() => {
      console.warn('Warning: image pull failed — if this is your first install, check your network connection.');
    });
    wizard.updateDeployStatus(allServices.map(service => ({ service, status: 'pending', label: 'Starting...' })));
    await runDockerCompose([...composeArgs, 'up', '-d', ...allServices]);

    // Poll container health so the wizard shows real progress per-service
    await pollContainerHealth(composeArgs, allServices, wizard);

    console.log('\n✓ All services are running:');
    for (const svc of allServices) {
      console.log(`  • ${svc}`);
    }
    console.log(`\n  Assistant:  http://localhost:${3800}`);
    console.log(`  Admin:      http://localhost:${3880}`);
    console.log(`  Memory API: http://localhost:${3898}`);
    console.log(`  Guardian:   http://localhost:${3899}`);
    console.log('');
    // pollContainerHealth returns as soon as all services are healthy, but
    // the frontend polls every 2.5s — keep the server alive long enough for
    // at least 2-3 polls to fetch the final "all running" state with URLs.
    await new Promise(resolve => setTimeout(resolve, 8000));
  } catch (err) {
    const errLabel = String(err);
    wizard.updateDeployStatus(allServices.map(service => ({ service, status: 'error', label: errLabel })));
    wizard.setDeployError(String(err));
    await new Promise(resolve => setTimeout(resolve, 10000));
    throw err;
  } finally {
    wizard.stop();
    if (openCodeSub) await openCodeSub.stop().catch(() => {});
  }
}

async function runFileInstall(filePath: string, noStart: boolean): Promise<void> {
  console.log(`Reading setup config from ${filePath}...`);
  if (!(await Bun.file(filePath).exists())) {
    throw new Error(`Setup config file not found: ${filePath}. Check the --file path and try again.`);
  }
  const config = await parseConfigFile(filePath, await Bun.file(filePath).text());

  // Normalize old wrapped format: { spec: { version, capabilities }, capabilities: [...] }
  // into flat format:              { version, capabilities: {...}, connections: [...] }
  if (config.spec && typeof config.spec === 'object') {
    const spec = config.spec as Record<string, unknown>;
    // Old format had connections array as top-level "capabilities"
    if (Array.isArray(config.capabilities)) config.connections = config.capabilities;
    config.version = spec.version;
    config.capabilities = spec.capabilities;
    delete config.spec;
  }

  if (config.version !== 2) throw new Error('Setup config must be version 2. See example.spec.yaml for the format.');
  if (!config.capabilities || typeof config.capabilities !== 'object' || Array.isArray(config.capabilities)) {
    throw new Error('Setup config must contain a "capabilities" object (llm, embeddings).');
  }

  // Resolve security.adminToken from environment when not in spec
  const security = (config.security ?? {}) as Record<string, unknown>;
  if (!security.adminToken && process.env.OP_ADMIN_TOKEN) {
    security.adminToken = process.env.OP_ADMIN_TOKEN;
    config.security = security;
  }

  const result = await performSetup(config as unknown as SetupSpec);
  if (!result.ok) throw new Error(`Setup failed: ${result.error}`);
  console.log('Setup complete.');
  if (noStart) { console.log('Config written. Run `openpalm start` to start services.'); return; }
  await requireDocker();
  await deployServices('install');
}

/**
 * Poll `docker compose ps` until all services are running/healthy (or timeout).
 * Updates the wizard deploy status per-service so the frontend shows real progress.
 */
async function pollContainerHealth(
  composeArgs: string[],
  services: string[],
  wizard: ReturnType<typeof createSetupServer>,
): Promise<void> {
  const MAX_WAIT_MS = 120_000; // 2 minutes
  const POLL_INTERVAL = 3_000;
  const start = Date.now();
  const running = new Set<string>();
  const psArgs = [...composeArgs, 'ps', '--format', 'json'];
  let prevRunningCount = 0;

  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const output = await runDockerComposeCapture(psArgs);
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;
        try {
          const container = JSON.parse(line) as { Service?: string; State?: string; Health?: string };
          const svc = container.Service;
          if (!svc || !services.includes(svc)) continue;
          const isHealthy = container.Health === 'healthy' || (container.State === 'running' && !container.Health);
          if (isHealthy) running.add(svc);
        } catch { /* skip malformed JSON line */ }
      }
    } catch { /* compose ps failed — retry next tick */ }

    if (running.size !== prevRunningCount) {
      prevRunningCount = running.size;
      const entries = services.map(svc => ({
        service: svc,
        status: (running.has(svc) ? 'running' : 'pending') as 'running' | 'pending',
        label: running.has(svc) ? 'Running' : 'Starting...',
      }));
      wizard.updateDeployStatus(entries);
    }

    if (running.size >= services.length) return;

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }

  // Timeout: mark remaining as running so the UI completes, but warn
  const pending = services.filter(s => !running.has(s));
  console.warn(`Warning: health check timed out for: ${pending.join(', ')}. They may still be starting.`);
  wizard.markAllRunning();
}

