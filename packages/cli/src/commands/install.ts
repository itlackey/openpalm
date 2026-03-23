import { defineCommand } from 'citty';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultWorkDir } from '../lib/paths.ts';
import { resolveOpenPalmHome, resolveConfigDir, resolveVaultDir, resolveDataDir } from '@openpalm/lib';
import { ensureSecrets, ensureStackEnv, resolveRequestedImageTag } from '../lib/env.ts';
import { ensureDirectoryTree, seedOpenPalmDir, openBrowser } from '../lib/docker.ts';
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
  console.log('Checking Docker...');
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

  console.log('Preparing directories...');
  await ensureDirectoryTree(homeDir, configDir, vaultDir, dataDir, workDir);

  try { await Bun.write(join(dataDir, 'host.json'), JSON.stringify(await detectHostInfo(), null, 2) + '\n'); }
  catch { /* non-fatal */ }

  console.log('Downloading assets...');
  try {
    await seedOpenPalmDir(options.version, homeDir, configDir, vaultDir, dataDir);
  } catch (err) {
    console.warn(`Warning: failed to download assets — ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('Configuring secrets...');
  await ensureSecrets(vaultDir);
  await ensureStackEnv(homeDir, vaultDir, workDir, options.version, resolveRequestedImageTag(options.version) ?? undefined);

  // Seed file-based volume mount targets so Docker doesn't create them as root-owned directories.
  for (const [path, content] of [
    [join(vaultDir, 'stack', 'guardian.env'), '# Guardian channel HMAC secrets — managed by openpalm\n'],
    [join(vaultDir, 'stack', 'auth.json'), '{}\n'],
  ] as const) {
    if (!(await Bun.file(path).exists())) await Bun.write(path, content);
  }

  // Pre-create all volume mount targets from compose files.
  // Docker creates missing bind mount paths as root-owned directories,
  // which causes EACCES failures inside containers running as non-root.
  await ensureVolumeMountTargets(homeDir, vaultDir);

  try { ensureOpenCodeConfig(); ensureOpenCodeSystemConfig(); } catch { /* non-fatal on first install */ }

  // Non-fatal varlock validation (15s timeout to avoid blocking the wizard)
  try {
    await Promise.race([
      runVarlockValidation(dataDir, vaultDir),
      new Promise((_, reject) => setTimeout(() => reject(new Error('varlock validation timed out')), 15_000)),
    ]);
  } catch { /* non-fatal */ }

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
  const homeDir = resolveOpenPalmHome();
  const vaultDir = resolveVaultDir();
  await ensureVolumeMountTargets(homeDir, vaultDir);
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

/**
 * Parse all compose files under homeDir/stack/ and pre-create every host-side
 * volume mount target as the current user. This prevents Docker from creating
 * them as root-owned, which causes EACCES inside non-root containers.
 *
 * For file mounts (source path has an extension like .json, .env), creates
 * an empty file. For directory mounts, creates the directory.
 */
async function ensureVolumeMountTargets(homeDir: string, vaultDir: string): Promise<void> {
  const { readFileSync, existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { parse: yamlParse } = await import('yaml');
  const { dirname } = await import('node:path');
  const stackDir = join(homeDir, 'stack');
  const composeFiles: string[] = [];

  // Collect all compose files
  const coreYml = join(stackDir, 'core.compose.yml');
  if (existsSync(coreYml)) composeFiles.push(coreYml);
  const addonsDir = join(stackDir, 'addons');
  if (existsSync(addonsDir)) {
    for (const entry of (await import('node:fs')).readdirSync(addonsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const addonYml = join(addonsDir, entry.name, 'compose.yml');
        if (existsSync(addonYml)) composeFiles.push(addonYml);
      }
    }
  }

  // Read env vars for variable substitution
  const envVars: Record<string, string> = { ...process.env };
  const stackEnv = join(vaultDir, 'stack', 'stack.env');
  if (existsSync(stackEnv)) {
    for (const line of readFileSync(stackEnv, 'utf-8').split('\n')) {
      const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) envVars[m[1]] = m[2];
    }
  }

  function resolveEnvVar(str: string): string {
    return str.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, name, def) => envVars[name] ?? def ?? '');
  }

  // Extract volume mount sources from all compose files
  for (const file of composeFiles) {
    let doc: any;
    try { doc = yamlParse(readFileSync(file, 'utf-8')); } catch { continue; }
    const services = doc?.services;
    if (!services) continue;

    for (const svc of Object.values(services) as any[]) {
      if (!Array.isArray(svc?.volumes)) continue;
      for (const vol of svc.volumes) {
        const raw = typeof vol === 'string' ? vol : vol?.source ?? vol?.target;
        if (!raw || typeof raw !== 'string') continue;

        // Parse "source:target[:opts]" format
        const hostPath = resolveEnvVar(typeof vol === 'string' ? vol.split(':')[0] : (vol.source ?? ''));
        if (!hostPath || !hostPath.startsWith('/')) continue;

        // Determine if this is a file mount (has extension) or directory mount
        const basename = hostPath.split('/').pop() ?? '';
        const isFile = basename.includes('.') && !basename.startsWith('.');

        if (existsSync(hostPath)) continue;

        if (isFile) {
          mkdirSync(dirname(hostPath), { recursive: true });
          writeFileSync(hostPath, '');
        } else {
          mkdirSync(hostPath, { recursive: true });
        }
      }
    }
  }
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
