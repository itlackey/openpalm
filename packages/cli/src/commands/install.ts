import { defineCommand } from 'citty';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultWorkDir } from '../lib/paths.ts';
import { resolveOpenPalmHome, resolveConfigDir, resolveVaultDir, resolveDataDir } from '@openpalm/lib';
import { ensureSecrets, ensureStackEnv, resolveRequestedImageTag } from '../lib/env.ts';
import { ensureDirectoryTree, fetchAsset, openBrowser } from '../lib/docker.ts';
import {
  ensureOpenCodeConfig, ensureOpenCodeSystemConfig,
  performSetup,
  type SetupSpec,
} from '@openpalm/lib';
import { ensureVarlock, prepareVarlockDir } from '../lib/varlock.ts';
import { detectHostInfo } from '../lib/host-info.ts';
import { ensureValidState } from '../lib/cli-state.ts';
import { buildManagedServiceNames, runComposeWithPreflight } from '../lib/cli-compose.ts';
import { createSetupServer } from '../setup-wizard/server.ts';
import { buildDeployStatusEntries } from './install-services.ts';

const SETUP_WIZARD_PORT = Number(process.env.OP_SETUP_PORT) || 8190;

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
  },
  async run({ args }) {
    const version = args.version || await resolveDefaultInstallRef();
    await bootstrapInstall({
      force: args.force,
      version,
      noStart: !args.start,
      noOpen: !args.open,
      file: args.file,
    });
  },
});

type InstallOptions = {
  force: boolean;
  version: string;
  noStart: boolean;
  noOpen: boolean;
  file?: string;
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
  const state = await ensureValidState();
  const managedServices = await buildManagedServiceNames(state);
  if (pull) await runComposeWithPreflight(state, ['pull', ...managedServices]).catch(() => console.warn('Warning: image pull failed.'));
  await runComposeWithPreflight(state, ['up', '-d', ...managedServices]);
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
  await requireDocker();

  const homeDir = resolveOpenPalmHome();
  const configDir = resolveConfigDir();
  const vaultDir = resolveVaultDir();
  const dataDir = resolveDataDir();
  const workDir = defaultWorkDir();

  const updateMode = await Bun.file(join(vaultDir, 'user', 'user.env')).exists();
  if (updateMode && !options.force) {
    throw new Error('OpenPalm appears to already be installed. Re-run install with --force to continue.');
  }

  await ensureDirectoryTree(homeDir, configDir, vaultDir, dataDir, workDir);

  try { await Bun.write(join(dataDir, 'host.json'), JSON.stringify(await detectHostInfo(), null, 2) + '\n'); }
  catch { /* non-fatal */ }

  await Bun.write(
    join(homeDir, 'stack', 'core.compose.yml'),
    await fetchAsset(options.version, '.openpalm/stack/core.compose.yml'),
  );

  // Download schemas and assets (all non-fatal)
  const downloads: Array<[string, string]> = [
    ['.openpalm/vault/user/user.env.schema', join(vaultDir, 'user', 'user.env.schema')],
    ['.openpalm/vault/stack/stack.env.schema', join(vaultDir, 'stack', 'stack.env.schema')],
    ['.openpalm/stack/addons/ollama/compose.yml', join(homeDir, 'stack', 'addons', 'ollama', 'compose.yml')],
    ['core/assistant/opencode/AGENTS.md', join(dataDir, 'assistant', 'AGENTS.md')],
    ['core/assistant/opencode/opencode.jsonc', join(dataDir, 'assistant', 'opencode.jsonc')],
    ['.openpalm/config/automations/cleanup-logs.yml', join(configDir, 'automations', 'cleanup-logs.yml')],
    ['.openpalm/config/automations/cleanup-data.yml', join(configDir, 'automations', 'cleanup-data.yml')],
    ['.openpalm/config/automations/validate-config.yml', join(configDir, 'automations', 'validate-config.yml')],
  ];
  await Promise.all(downloads.map(async ([remote, local]) => {
    try { await Bun.write(local, await fetchAsset(options.version, remote)); }
    catch { /* non-fatal */ }
  }));

  await ensureSecrets(vaultDir);
  await ensureStackEnv(homeDir, vaultDir, workDir, options.version, resolveRequestedImageTag(options.version) ?? undefined);

  try { ensureOpenCodeConfig(); ensureOpenCodeSystemConfig(); } catch { /* non-fatal on first install */ }

  // Non-fatal varlock validation
  try { await runVarlockValidation(dataDir, vaultDir); } catch { /* non-fatal */ }

  if (options.noStart && !options.file) {
    console.log('OpenPalm files prepared. Run `openpalm start` to start services.');
    return;
  }

  // ── File-based install (--file / -f) ──────────────────────────────────
  if (options.file) {
    await runFileInstall(options.file, options.noStart);
    return;
  }

  // ── Setup Wizard (first install) ──────────────────────────────────────
  if (!updateMode) {
    await runWizardInstall(configDir, options.noOpen);
    return;
  }

  // ── Update mode (no wizard) ───────────────────────────────────────────
  await deployServices('update', false);
}

async function runWizardInstall(configDir: string, noOpen: boolean): Promise<void> {
  console.log('Starting setup wizard...');
  let wizard;
  try {
    wizard = createSetupServer(SETUP_WIZARD_PORT, { configDir });
  } catch (err) {
    const msg = String(err);
    throw msg.includes('EADDRINUSE') || msg.includes('address already in use') || msg.includes('Failed to start')
      ? new Error(`Port ${SETUP_WIZARD_PORT} is in use. Stop the conflicting process or set OP_SETUP_PORT=<port>.`)
      : err;
  }
  const wizardUrl = `http://localhost:${wizard.server.port}/setup`;
  console.log(`Setup wizard running at ${wizardUrl}`);
  if (!noOpen) await openBrowser(wizardUrl);

  const result = await wizard.waitForComplete();
  if (!result.ok) { wizard.stop(); throw new Error(`Setup failed: ${result.error ?? 'unknown error'}`); }

  console.log('Setup complete. Starting services...');
  const state = await ensureValidState();
  const managedServices = await buildManagedServiceNames(state);
  const allServices = managedServices;
  try {
    wizard.updateDeployStatus(buildDeployStatusEntries(allServices, 'pending', 'Waiting...'));
    await runComposeWithPreflight(state, ['pull', ...allServices]).catch(() => {
      console.warn('Warning: image pull failed — if this is your first install, check your network connection.');
    });
    wizard.updateDeployStatus(buildDeployStatusEntries(allServices, 'pending', 'Starting...'));
    await runComposeWithPreflight(state, ['up', '-d', ...allServices]);
    wizard.markAllRunning();
    console.log(JSON.stringify({ ok: true, mode: 'install', services: allServices }, null, 2));
    await new Promise(resolve => setTimeout(resolve, 3000));
  } catch (err) {
    wizard.updateDeployStatus(buildDeployStatusEntries(allServices, 'error', String(err)));
    wizard.setDeployError(String(err));
    await new Promise(resolve => setTimeout(resolve, 10000));
    throw err;
  } finally { wizard.stop(); }
}

async function runFileInstall(filePath: string, noStart: boolean): Promise<void> {
  console.log(`Reading setup config from ${filePath}...`);
  if (!(await Bun.file(filePath).exists())) {
    throw new Error(`Setup config file not found: ${filePath}. Check the --file path and try again.`);
  }
  const config = await parseConfigFile(filePath, await Bun.file(filePath).text());
  if (config.version === 1) throw new Error('v1 setup config format is no longer supported. Use the v2 SetupSpec format (with a "spec" field).');
  if (!config.spec) throw new Error('Setup config must contain a "spec" field with the v2 StackSpec.');

  const result = await performSetup(config as unknown as SetupSpec);
  if (!result.ok) throw new Error(`Setup failed: ${result.error}`);
  console.log('Setup complete.');
  if (noStart) { console.log('Config written. Run `openpalm start` to start services.'); return; }
  await deployServices('install');
}

async function runVarlockValidation(dataDir: string, vaultDir: string): Promise<void> {
  const varlockBin = await ensureVarlock(dataDir);
  const schemaPath = join(vaultDir, 'user', 'user.env.schema');
  if (!(await Bun.file(schemaPath).exists())) return;
  const tmpDir = await prepareVarlockDir(schemaPath, join(vaultDir, 'user', 'user.env'));
  try {
    const code = await Bun.spawn([varlockBin, 'load', '--path', `${tmpDir}/`], { stdout: 'ignore', stderr: 'ignore' }).exited;
    console.log(code === 0 ? 'Configuration validated.' : 'Configuration has validation warnings (non-fatal on first install).');
  } finally { await rm(tmpDir, { recursive: true, force: true }); }
}
