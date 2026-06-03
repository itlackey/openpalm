import { defineCommand } from 'citty';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultWorkDir } from '../lib/paths.ts';
import { resolveOpenPalmHome, resolveConfigDir } from '@openpalm/lib';
import { ensureSecrets, ensureStackEnv } from '../lib/env.ts';
import { ensureDirectoryTree, seedOpenPalmDir, seedUiBuild } from '../lib/io.ts';
import { openBrowser } from '../lib/browser.ts';
import { runDockerCompose } from '../lib/docker.ts';
import {
  backupOpenPalmHome,
  buildComposeCliArgs,
  ensureOpenCodeConfig, ensureOpenCodeSystemConfig,
  performSetup,
  applyInstall,
  buildManagedServices,
  createState,
  createLogger,
  resolveRequestedImageTag,
  ensureAkmUserEnv,
  type SetupSpec,
} from '@openpalm/lib';
import { detectHostInfo } from '../lib/host-info.ts';
import { ensureValidState } from '../lib/cli-state.ts';

const logger = createLogger('cli:install');

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
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Auto-confirm destructive prompts (e.g. --force backup of existing OP_HOME)',
      default: false,
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
        assumeYes: args.yes,
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
  assumeYes: boolean;
};

/**
 * Prompt the user for a y/N confirmation on stdin/stdout. Returns false in
 * any non-interactive context (no TTY) so CI runs do not hang waiting on
 * input — callers must pair this with an explicit `--yes` flag for
 * unattended invocations.
 */
async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

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
  const dataDir = `${homeDir}/data`;
  const workDir = defaultWorkDir();

  // Use knowledge/env/stack.env (always present after a successful install) as the
  // canonical "already installed" indicator.
  const alreadyInstalled = await Bun.file(join(homeDir, 'knowledge', 'env', 'stack.env')).exists();
  if (alreadyInstalled && !options.force) {
    throw new Error('OpenPalm appears to already be installed. Re-run install with --force to continue.');
  }

  if (alreadyInstalled && options.force) {
    // Use the helper's own backup-path convention so the prompt is honest about
    // Match backupOpenPalmHome()'s convention so the prompt is honest.
    const plannedBackup = `${homeDir}/data/backups/<timestamp>`;

    // Skip the prompt when --yes was passed OR when there's no TTY (CI/scripts).
    // Without the TTY exemption we would silently hang a non-interactive
    // pipeline waiting for stdin, which is worse than auto-confirming.
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (!options.assumeYes && interactive) {
      const proceed = await promptYesNo(
        `--force will move the existing OpenPalm install at ${homeDir} to ${plannedBackup}. Continue? [y/N]`,
      );
      if (!proceed) {
        console.log('Install aborted. Re-run with --yes (or -y) to skip this confirmation in non-interactive use.');
        return;
      }
    }
    const backupDir = backupOpenPalmHome(homeDir);
    if (backupDir) {
      console.log(`Backed up existing OP_HOME to ${backupDir}`);
    }
  }

  // ── Bootstrap files ────────────────────────────────────────────────────
  await prepareInstallFiles(homeDir, configDir, dataDir, workDir, options.version);

  // ── Configure ──────────────────────────────────────────────────────────
  // File-based install: read config, run performSetup, optionally deploy
  if (options.file) {
    await runFileInstall(options.file, options.noStart);
    return;
  }

  // Interactive wizard: start the admin UI which serves the setup wizard
  const needsWizard = !alreadyInstalled || options.force;
  if (needsWizard) {
    await runWizardInstall(options.noOpen);
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
  homeDir: string, configDir: string, dataDir: string, workDir: string, version: string,
): Promise<void> {
  console.log('Preparing directories...');
  await ensureDirectoryTree(homeDir, workDir);

  try { await Bun.write(join(dataDir, 'host.json'), JSON.stringify(await detectHostInfo(), null, 2) + '\n'); }
  catch (err) { logger.debug('failed to write host.json', { error: String(err) }); }

  // Seed OP_HOME from .openpalm/ (local source if available, else GitHub tarball)
  await seedOpenPalmDir(version, homeDir, configDir, dataDir);
  // Install UI build to data/ui/ (local build if available, else GitHub release asset)
  await seedUiBuild(version, dataDir);

  console.log('Configuring secrets...');
  await ensureSecrets(dataDir);
  await ensureStackEnv(homeDir, configDir, workDir, version, resolveRequestedImageTag(version) ?? undefined);

  if (!(await Bun.file(join(configDir, 'stack', 'auth.json')).exists())) {
    await Bun.write(join(configDir, 'stack', 'auth.json'), '{}\n');
  }
  // Ensure the akm env:user file exists (empty 0600) so the assistant can
  // source it. Owned and edited directly by OpenPalm — see akm-user-env.ts.
  ensureAkmUserEnv(createState());

  try { ensureOpenCodeConfig(); ensureOpenCodeSystemConfig(); } catch (err) { logger.debug('failed to ensure OpenCode config', { error: String(err) }); }
}

/**
 * Launch the UI host server to handle first-time setup.
 *
 * The SvelteKit UI detects that setup is not complete (via hooks.server.ts)
 * and redirects to /setup where the wizard runs. Deploy is triggered from
 * within the UI process after the user completes the wizard.
 *
 * Pre-flight: `requireDocker()` runs FIRST so users hit our friendly Docker
 * error before the browser opens to a wizard that will fail at the end of
 * a 10-step flow.
 */
async function runWizardInstall(noOpen: boolean): Promise<void> {
  await requireDocker();
  const port = Number(process.env.OP_HOST_UI_PORT) || 3880;
  console.log(`Setup wizard: http://localhost:${port}/setup`);
  const { startUIServer } = await import('../lib/ui-server.ts');
  await startUIServer({ open: !noOpen, port });
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

  // Resolve security.uiLoginPassword from environment when not in spec.
  // Phase 4 (auth/proxy refactor) renamed the env var to OP_UI_LOGIN_PASSWORD
  // and the spec field to security.uiLoginPassword.
  const security = (config.security ?? {}) as Record<string, unknown>;
  if (!security.uiLoginPassword && process.env.OP_UI_LOGIN_PASSWORD) {
    security.uiLoginPassword = process.env.OP_UI_LOGIN_PASSWORD;
    config.security = security;
  }

  const result = await performSetup(config as unknown as SetupSpec);
  if (!result.ok) throw new Error(`Setup failed: ${result.error}`);
  console.log('Setup complete.');
  if (noStart) { console.log('Config written. Run `openpalm start` to start services.'); return; }
  await requireDocker();
  await deployServices('install');
}
