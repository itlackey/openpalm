import { defineCommand } from 'citty';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultConfigHome, defaultDataHome, defaultStateHome, defaultWorkDir } from '../lib/paths.ts';
import { ensureSecrets, ensureStackEnv } from '../lib/env.ts';
import { ensureDirectoryTree, fetchAsset, runDockerCompose, openBrowser } from '../lib/docker.ts';
import {
  ensureOpenCodeConfig, ensureOpenCodeSystemConfig, ensureAdminOpenCodeConfig, FilesystemAssetProvider,
  performSetupFromConfig,
  type SetupConfig, type SetupResult,
} from '@openpalm/lib';
import { ensureVarlock, prepareVarlockDir } from '../lib/varlock.ts';
import { detectHostInfo } from '../lib/host-info.ts';
import { ensureStagedState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';
import { createSetupServer } from '../setup-wizard/server.ts';
import { buildInstallServiceNames, buildDeployStatusEntries } from './install-services.ts';

const DEFAULT_INSTALL_REF = 'main';
const SETUP_WIZARD_PORT = Number(process.env.OPENPALM_SETUP_PORT) || 8100;

export default defineCommand({
  meta: {
    name: 'install',
    description: 'Bootstrap XDG dirs, download assets, run setup wizard, start core services',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Skip "already installed" check',
      default: false,
    },
    version: {
      type: 'string',
      description: 'Install specific repository ref (default: main)',
      default: DEFAULT_INSTALL_REF,
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
    await bootstrapInstall({
      force: args.force,
      version: args.version,
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

export async function bootstrapInstall(options: InstallOptions): Promise<void> {
  if (!Bun.which('docker')) {
    throw new Error('Docker is not installed. Install Docker first: https://docs.docker.com/get-docker/');
  }

  const dockerInfo = Bun.spawn(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' });
  if ((await dockerInfo.exited) !== 0) {
    throw new Error('Docker is not running (or current user lacks permission). Start Docker and retry.');
  }

  const composeVersion = Bun.spawn(['docker', 'compose', 'version'], { stdout: 'ignore', stderr: 'ignore' });
  if ((await composeVersion.exited) !== 0) {
    throw new Error('Docker Compose v2 is required. Install it: https://docs.docker.com/compose/install/');
  }

  const configHome = defaultConfigHome();
  const dataHome = defaultDataHome();
  const stateHome = defaultStateHome();
  const workDir = defaultWorkDir();

  const secretsPath = join(configHome, 'secrets.env');
  const updateMode = await Bun.file(secretsPath).exists();
  if (updateMode && !options.force) {
    throw new Error('OpenPalm appears to already be installed. Re-run install with --force to continue.');
  }

  await ensureDirectoryTree(configHome, dataHome, stateHome, workDir);

  // Detect host system info (non-fatal)
  try {
    const hostInfo = await detectHostInfo();
    await Bun.write(join(dataHome, 'host.json'), JSON.stringify(hostInfo, null, 2) + '\n');
  } catch {
    // Host detection failure is non-fatal
  }

  const composeContent = await fetchAsset(options.version, 'docker-compose.yml');
  const caddyContent = await fetchAsset(options.version, 'Caddyfile');
  await Bun.write(join(dataHome, 'docker-compose.yml'), composeContent);
  await Bun.write(join(dataHome, 'caddy', 'Caddyfile'), caddyContent);
  await Bun.write(join(stateHome, 'artifacts', 'docker-compose.yml'), composeContent);
  await Bun.write(join(stateHome, 'artifacts', 'Caddyfile'), caddyContent);

  // Download schemas to both DATA_HOME (for FilesystemAssetProvider) and STATE_HOME (for varlock validation)
  for (const schemaFile of ['secrets.env.schema', 'stack.env.schema', 'setup-config.schema.json']) {
    try {
      const content = await fetchAsset(options.version, schemaFile);
      await Bun.write(join(dataHome, schemaFile), content);
      await Bun.write(join(stateHome, 'artifacts', schemaFile), content);
    } catch (err) {
      console.warn(`Warning: could not download schema '${schemaFile}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Download remaining assets needed by FilesystemAssetProvider
  const assetFiles: Array<{ remote: string; localPath: string }> = [
    { remote: 'ollama.yml', localPath: join(dataHome, 'ollama.yml') },
    { remote: 'admin.yml', localPath: join(dataHome, 'admin.yml') },
    { remote: 'AGENTS.md', localPath: join(dataHome, 'assistant', 'AGENTS.md') },
    { remote: 'opencode.jsonc', localPath: join(dataHome, 'assistant', 'opencode.jsonc') },
    { remote: 'admin-opencode.jsonc', localPath: join(dataHome, 'admin', 'opencode.jsonc') },
    { remote: 'cleanup-logs.yml', localPath: join(dataHome, 'automations', 'cleanup-logs.yml') },
    { remote: 'cleanup-data.yml', localPath: join(dataHome, 'automations', 'cleanup-data.yml') },
    { remote: 'validate-config.yml', localPath: join(dataHome, 'automations', 'validate-config.yml') },
  ];
  await Promise.all(
    assetFiles.map(async ({ remote, localPath }) => {
      try {
        const content = await fetchAsset(options.version, remote);
        await Bun.write(localPath, content);
      } catch (err) {
        console.warn(`Warning: could not download asset '${remote}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  await ensureSecrets(configHome);
  await ensureStackEnv(configHome, dataHome, stateHome, workDir, options.version);
  // Seed OpenCode config — non-fatal since performSetup() also seeds these
  try {
    const fsAssets = new FilesystemAssetProvider(dataHome);
    ensureOpenCodeConfig();
    ensureOpenCodeSystemConfig(fsAssets);
    ensureAdminOpenCodeConfig(fsAssets);
  } catch {
    // Assets may not be available yet on first install; performSetup() will retry
  }

  // Non-fatal validation
  try {
    const varlockBin = await ensureVarlock(stateHome);
    const schemaPath = join(stateHome, 'artifacts', 'secrets.env.schema');
    const envPath = join(configHome, 'secrets.env');
    if (await Bun.file(schemaPath).exists()) {
      const tmpDir = await prepareVarlockDir(schemaPath, envPath);
      try {
        const proc = Bun.spawn([varlockBin, 'load', '--path', `${tmpDir}/`], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
        const code = await proc.exited;
        if (code === 0) {
          console.log('Configuration validated.');
        } else {
          console.warn('Configuration has validation warnings (non-fatal on first install).');
        }
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }
  } catch {
    // Varlock install/execution failures are non-fatal during install
  }

  if (options.noStart && !options.file) {
    console.log('OpenPalm files prepared. Run `openpalm start` to start services.');
    return;
  }

  // ── File-based install (--file / -f) ──────────────────────────────────
  // Read a JSON or YAML setup config file and call performSetup() or
  // performSetupFromConfig() directly — no wizard needed.

  if (options.file) {
    console.log(`Reading setup config from ${options.file}...`);

    if (!(await Bun.file(options.file).exists())) {
      throw new Error(`Setup config file not found: ${options.file}. Check the --file path and try again.`);
    }
    let raw: string;
    try {
      raw = await Bun.file(options.file).text();
    } catch (err) {
      throw new Error(`Failed to read setup config file '${options.file}': ${err instanceof Error ? err.message : String(err)}`);
    }

    const ext = options.file.toLowerCase();
    let parsed: unknown;
    try {
      if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
        const { parse } = await import('yaml');
        parsed = parse(raw);
      } else if (ext.endsWith('.json')) {
        parsed = JSON.parse(raw);
      } else {
        throw new Error(`Unsupported config file format: ${options.file}. Use .json or .yaml.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Unsupported config file format:')) {
        throw err;
      }
      throw new Error(`Failed to parse setup config '${options.file}': ${err instanceof Error ? err.message : String(err)}`);
    }

    const fsAssets = new FilesystemAssetProvider(dataHome);
    const config = parsed as Record<string, unknown>;
    let result: SetupResult;

    if (typeof config.version !== "number") {
      throw new Error(
        `Setup config file is missing a 'version' field. Use 'version: 1' for the current format.`
      );
    }
    if (config.version === 1) {
      result = await performSetupFromConfig(config as SetupConfig, fsAssets);
    } else {
      throw new Error(`Unsupported setup config version: ${config.version}. Only version 1 is supported.`);
    }

    if (!result.ok) throw new Error(`Setup failed: ${result.error}`);
    console.log('Setup complete.');

    if (options.noStart) {
      console.log('Config written. Run `openpalm start` to start services.');
      return;
    }

    // Deploy (same as existing update-mode code)
    console.log('Starting services...');
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    const managedServices = buildManagedServiceNames(state);
    const allServices = buildInstallServiceNames(managedServices);

    await runDockerCompose([...composeArgs, 'pull', ...allServices]).catch(() => {
      console.warn('Warning: image pull failed.');
    });
    await runDockerCompose([...composeArgs, 'up', '-d', ...allServices]);
    console.log(JSON.stringify({ ok: true, mode: 'install', services: allServices }, null, 2));
    return;
  }

  // ── Setup Wizard ──────────────────────────────────────────────────────
  // First-time install: serve the setup wizard locally and wait for user
  // to complete it. The wizard calls performSetup() from @openpalm/lib
  // which writes secrets, connection profiles, memory config, and stages
  // all artifacts. No admin container needed.

  if (!updateMode) {
    console.log('Starting setup wizard...');

    let wizard;
    try {
      wizard = createSetupServer(SETUP_WIZARD_PORT, { configDir: configHome });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('EADDRINUSE') || msg.includes('address already in use') || msg.includes('Failed to start')) {
        throw new Error(`Port ${SETUP_WIZARD_PORT} is in use. Stop the conflicting process or set OPENPALM_SETUP_PORT=<port>.`);
      }
      throw err;
    }
    const wizardUrl = `http://localhost:${wizard.server.port}/setup`;
    console.log(`Setup wizard running at ${wizardUrl}`);

    if (!options.noOpen) {
      await openBrowser(wizardUrl);
    }

    // Block until user completes the wizard
    const result = await wizard.waitForComplete();

    if (!result.ok) {
      wizard.stop();
      throw new Error(`Setup failed: ${result.error ?? 'unknown error'}`);
    }

    console.log('Setup complete. Starting services...');

    // Keep wizard server running for deploy status polling from the browser.
    // Stage artifacts and start services while the wizard shows progress.
    try {
      const state = await ensureStagedState();
      const composeArgs = fullComposeArgs(state);
      const managedServices = buildManagedServiceNames(state);
      const allServices = buildInstallServiceNames(managedServices);

      wizard.updateDeployStatus(buildDeployStatusEntries(allServices, 'pending', 'Waiting...'));

      await runDockerCompose([...composeArgs, 'pull', ...allServices]).catch(() => {
        console.warn('Warning: image pull failed — if this is your first install, check your network connection.');
      });

      wizard.updateDeployStatus(buildDeployStatusEntries(allServices, 'pulling', 'Starting...'));

      await runDockerCompose([...composeArgs, 'up', '-d', ...allServices]);

      wizard.markAllRunning();

      console.log(JSON.stringify({
        ok: true,
        mode: 'install',
        services: allServices,
      }, null, 2));

      // Give the browser a moment to poll the final status, then stop
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (err) {
      wizard.setDeployError(String(err));
      // Keep server alive briefly so user can see the error
      await new Promise(resolve => setTimeout(resolve, 10000));
      throw err;
    } finally {
      wizard.stop();
    }

    return;
  }

  // ── Start Core Services (update mode — no wizard) ────────────────────
  // Stage artifacts and start all managed services directly via Docker
  // Compose. No admin container required for lifecycle operations.

  const state = await ensureStagedState();
  const composeArgs = fullComposeArgs(state);
  const managedServices = buildManagedServiceNames(state);
  const allServices = buildInstallServiceNames(managedServices);

  await runDockerCompose([...composeArgs, 'up', '-d', ...allServices]);

  console.log(JSON.stringify({
    ok: true,
    mode: 'update',
    services: allServices,
  }, null, 2));
}
