import { defineCommand } from 'citty';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultConfigHome, defaultDataHome, defaultStateHome, defaultWorkDir } from '../lib/paths.ts';
import { ensureSecrets, ensureStackEnv } from '../lib/env.ts';
import { isAdminReachable, adminRequest } from '../lib/admin.ts';
import { ensureDirectoryTree, fetchAsset, runDockerCompose, openBrowser } from '../lib/docker.ts';
import { ensureOpenCodeConfig, ensureOpenCodeSystemConfig, ensureAdminOpenCodeConfig, FilesystemAssetProvider } from '@openpalm/lib';
import { ensureVarlock, prepareVarlockDir } from '../lib/varlock.ts';
import { detectHostInfo } from '../lib/host-info.ts';
import { loadAdminToken } from '../lib/env.ts';
import { ensureStagedState, fullComposeArgs, buildManagedServiceNames } from '../lib/staging.ts';
import { createSetupServer } from '../setup-wizard/server.ts';
import { buildInstallServiceNames, buildDeployStatusEntries } from './install-services.ts';

const DEFAULT_INSTALL_REF = cliPkg.version ? `v${cliPkg.version}` : 'main';
const SETUP_WIZARD_PORT = 8100;

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
      description: 'Install specific release ref (default: current CLI version)',
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
  },
  async run({ args }) {
    // If the stack is already running AND we have a valid admin token,
    // delegate to the admin API. Otherwise fall through to bootstrap.
    if (await isAdminReachable()) {
      const token = await loadAdminToken();
      if (token) {
        console.log(JSON.stringify(await adminRequest('/admin/install', { method: 'POST' }), null, 2));
        return;
      }
      // No token available — fall through to bootstrap install which doesn't need auth.
      console.warn('Stack is running but no admin token is configured. Proceeding with bootstrap install.');
    }

    await bootstrapInstall({
      force: args.force,
      version: args.version,
      noStart: !args.start,
      noOpen: !args.open,
    });
  },
});

type InstallOptions = {
  force: boolean;
  version: string;
  noStart: boolean;
  noOpen: boolean;
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
  const secretsSchemaContent = await fetchAsset(options.version, 'secrets.env.schema');
  const stackSchemaContent = await fetchAsset(options.version, 'stack.env.schema');
  await Bun.write(join(dataHome, 'secrets.env.schema'), secretsSchemaContent);
  await Bun.write(join(dataHome, 'stack.env.schema'), stackSchemaContent);
  await Bun.write(join(stateHome, 'artifacts', 'secrets.env.schema'), secretsSchemaContent);
  await Bun.write(join(stateHome, 'artifacts', 'stack.env.schema'), stackSchemaContent);

  // Download remaining assets needed by FilesystemAssetProvider
  const assetFiles: Array<{ remote: string; localPath: string }> = [
    { remote: 'ollama.yml', localPath: join(dataHome, 'ollama.yml') },
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

  if (options.noStart) {
    console.log('OpenPalm files prepared. Run `openpalm start` to start services.');
    return;
  }

  // ── Setup Wizard ──────────────────────────────────────────────────────
  // First-time install: serve the setup wizard locally and wait for user
  // to complete it. The wizard calls performSetup() from @openpalm/lib
  // which writes secrets, connection profiles, memory config, and stages
  // all artifacts. No admin container needed.

  if (!updateMode) {
    console.log('Starting setup wizard...');

    const wizard = createSetupServer(SETUP_WIZARD_PORT, { configDir: configHome });
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

      await runDockerCompose([...composeArgs, '--profile', 'admin', 'pull', ...allServices]).catch(() => {
        // Pull failure is non-fatal — images may already be cached
      });

      wizard.updateDeployStatus(buildDeployStatusEntries(allServices, 'pulling', 'Starting...'));

      await runDockerCompose([...composeArgs, '--profile', 'admin', 'up', '-d', ...allServices]);

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

  await runDockerCompose([...composeArgs, '--profile', 'admin', 'up', '-d', ...allServices]);

  console.log(JSON.stringify({
    ok: true,
    mode: 'update',
    services: allServices,
  }, null, 2));
}
