import { defineCommand } from 'citty';
import { join } from 'node:path';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultWorkDir } from '../lib/paths.ts';
import { defineAction } from '../lib/action.ts';
import { promptYesNo } from '../lib/prompt.ts';
import { resolveLatestReleaseTag } from '../lib/github.ts';
import { DEFAULT_UI_PORT } from '../lib/ports.ts';
import { resolveOpenPalmHome, resolveConfigDir } from '@openpalm/lib';
import { ensureDirectoryTree, applyHomeSeed, seedUiBuild, seedClientBuild, uiUpdateChannel } from '../lib/io.ts';
import {
  backupOpenPalmHome,
  pruneBackupDirs,
  buildComposeOptions,
  composeDown,
  initializeStateSecrets,
  ensureOpenCodeConfig, ensureOpenCodeSystemConfig,
  performSetup,
  createState,
  createLogger,
  resolveRequestedImageTag,
  ensureAkmUserEnv,
  PLATFORM_VERSION,
  runDeploy,
  markSetupComplete,
  writeSystemEnv,
  patchSecretsEnvFile,
  collectNetworkExposureWarnings,
  type SetupSpec,
} from '@openpalm/lib';
import { detectHostInfo } from '../lib/host-info.ts';
import { ensureValidState } from '../lib/cli-state.ts';

const logger = createLogger('cli:install');

export async function resolveDefaultInstallRef(): Promise<string> {
  // Prefer the latest published release tag; fall back to the packaged CLI
  // version (then `main`) when the network lookup fails.
  return (await resolveLatestReleaseTag()) ?? cliPkg.version ?? 'main';
}

export default defineCommand({
  meta: {
    name: 'install',
    description: 'Bootstrap home dirs, download assets, run setup wizard, start core services',
  },
  args: {
    force: {
      type: 'boolean',
      description:
        'Skip "already installed" check. Backs up the existing OP_HOME to ' +
        'data/backups/<timestamp> first, then prunes old backups down to the 3 ' +
        'most recent (pre-rollback/pre-update safety snapshots are never pruned).',
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
  run: defineAction(
    async ({ args }) => {
      const version = args.version || await resolveDefaultInstallRef();
      // Only a user-supplied --version pins the Docker image tag. Otherwise the
      // images track `latest`: the host (CLI/UI) and the service images version
      // INDEPENDENTLY (host-only releases publish no matching image), so pinning
      // the image to the resolved host version stranded installs on a stale
      // assistant. The install REF (GitHub assets) still falls back to the CLI
      // version above; only OP_IMAGE_TAG is decoupled.
      const explicitImageTag = args.version ? (resolveRequestedImageTag(String(args.version)) ?? undefined) : undefined;
      await bootstrapInstall({
        force: !!args.force,
        version: String(version),
        explicitImageTag,
        noStart: !args.start,
        noOpen: !args.open,
        file: args.file ? String(args.file) : undefined,
        assumeYes: !!args.yes,
      });
    },
    (message) => console.error(`Error: ${message}`),
  ),
});

type InstallOptions = {
  force: boolean;
  version: string;
  /** Image tag pin from an explicit --version; undefined => track `latest`. */
  explicitImageTag?: string;
  noStart: boolean;
  noOpen: boolean;
  file?: string;
  assumeYes: boolean;
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
  // PR #564 second retest R9: pass the setup-completion callback so a healthy
  // non-interactive (file) install records OP_SETUP_COMPLETE=true. Without it,
  // runDeploy brought the stack up healthy but never stamped completion, so the
  // UI later bounced the operator back to the setup wizard. runDeploy only fires
  // this once CORE services are healthy, so it stays correct for every mode.
  const result = await runDeploy(state, { markSetupComplete: () => markSetupComplete(state) });
  if (result.deployError) throw new Error(result.deployError);
  console.log(JSON.stringify({ ok: true, mode, services: result.deployStatus.map((entry) => entry.service), pull }, null, 2));
  return result.deployStatus.map((entry) => entry.service);
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
  // Warn early if any bind address is non-loopback so the operator sees it
  // before services start. #563 — preset-aware: a matched network access
  // preset collapses to one informational line; unexplained exposure stays
  // loud (D9).
  for (const line of collectNetworkExposureWarnings(process.env as Record<string, string>)) {
    logger.warn(line);
  }

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
    // Match backupOpenPalmHome()'s convention so the prompt is honest.
    const plannedBackup = `${homeDir}/data/backups/<timestamp>`;

    // Skip the prompt when --yes was passed OR when there's no TTY (CI/scripts).
    // Without the TTY exemption we would silently hang a non-interactive
    // pipeline waiting for stdin, which is worse than auto-confirming.
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (!options.assumeYes && interactive) {
      const proceed = await promptYesNo(
        `--force will back up (copy) the existing OpenPalm install at ${homeDir} to ${plannedBackup}, ` +
        'then prune old backups down to the 3 most recent. Continue? [y/N]',
      );
      if (!proceed) {
        console.log('Install aborted. Re-run with --yes (or -y) to skip this confirmation in non-interactive use.');
        return;
      }
    }
    // #461: stop the currently-running stack BEFORE backing up OP_HOME.
    // Backing up the home dir while the old stack is up leaves orphaned containers
    // holding the project name + host ports, so the fresh install collides on
    // `compose up`. Volumes are preserved (no -v). Best-effort: a Docker-down
    // host or a never-started install simply has nothing to bring down.
    try {
      const existingState = createState();
      const composeOpts = buildComposeOptions(existingState);
      if (composeOpts.files.length > 0) {
        console.log('Stopping existing stack before backup...');
        const down = await composeDown({ ...composeOpts, removeVolumes: false });
        if (!down.ok) {
          logger.debug('pre-force compose down returned non-zero (likely nothing to stop)', { stderr: down.stderr?.slice(0, 300) });
        }
      }
    } catch (err) {
      logger.debug('pre-force compose down threw — continuing', { error: String(err) });
    }

    const backupDir = backupOpenPalmHome(homeDir);
    if (backupDir) {
      console.log(`Backed up existing OP_HOME to ${backupDir}`);
      // Bounded retention: keep the most recent few snapshots so repeated
      // --force runs can't accumulate unbounded and fill the disk.
      pruneBackupDirs(homeDir, 3);
    }
  }

  // ── Bootstrap files ────────────────────────────────────────────────────
  await prepareInstallFiles(homeDir, configDir, dataDir, workDir, options.version);

  // ── Configure ──────────────────────────────────────────────────────────
  // File-based install: read config, run performSetup, optionally deploy
  if (options.file) {
    await runFileInstall(options.file, options.noStart, options.explicitImageTag);
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

// Exported (not just internal) so it's independently testable — see
// install-prepare.test.ts's "seeds the client build" coverage (C3) — without
// exercising the rest of bootstrapInstall (wizard/deploy/docker).
export async function prepareInstallFiles(
  homeDir: string, configDir: string, dataDir: string, workDir: string, version: string,
): Promise<void> {
  console.log('Preparing directories...');
  await ensureDirectoryTree(homeDir, workDir);

  try { await Bun.write(join(dataDir, 'host.json'), `${JSON.stringify(await detectHostInfo(), null, 2)}\n`); }
  catch (err) { logger.debug('failed to write host.json', { error: String(err) }); }

  // Seed OP_HOME from the bundled .openpalm/ source (skeleton data/ + managed
  // compose, stamp-gated/skip-existing). This is the PRE-WIZARD seed and is
  // load-bearing: the wizard's `openpalm ui serve` child reads seeded
  // system/stack assets at boot (runStartupApply -> resolveRuntimeFiles), and
  // the bundled-asset fallback does not survive into the packaged UI build, so
  // the live seeded copy must exist before /setup is served.
  //
  // NOT redundant with applyInstall's applyHome: the deploy paths (runFileInstall
  // and the update-mode redeploy) reach applyHome via runDeploy -> applyInstall,
  // which re-seeds idempotently; but the interactive wizard serves BEFORE any
  // applyInstall runs (deploy happens later from inside the UI), so this explicit
  // seed is the only one that runs before the wizard comes up.
  //
  // Stamp with PLATFORM_VERSION (not `version`, the GitHub install ref like
  // "v0.12.5"/"main") so this pre-wizard seed and applyHome's seed agree on the
  // stamp written into .skeleton-version.
  await applyHomeSeed(PLATFORM_VERSION, homeDir, configDir, dataDir);
  // Install UI build to data/ui/ (local build if available, else the
  // @openpalm/ui npm bundle on this release stream's channel). @openpalm/ui is
  // independently versioned, so seed by dist-tag CHANNEL (latest/next) rather
  // than the platform `version`, which is not a valid UI version.
  // NON-FATAL: a download hiccup must not abort the install — the stack still
  // comes up and the UI is (re)seeded on `openpalm ui serve` / `update` or
  // Electron launch. (Also keeps unit tests off the network when no local build.)
  try {
    await seedUiBuild(uiUpdateChannel(version), dataDir);
  } catch (err) {
    logger.warn('UI build not seeded; it will be installed on first `ui serve`/update', { error: String(err) });
  }
  // Install the client app build to data/client/ ({build,bin}) the SAME way
  // (C3): before this, the client artifact was only ever fetched lazily at
  // `openpalm ui serve` time, so an air-gapped/offline install never got one
  // at all. NON-FATAL for the same reason as the UI build above.
  try {
    await seedClientBuild(uiUpdateChannel(version), dataDir);
  } catch (err) {
    logger.warn('Client build not seeded; it will be installed on first `ui serve`/update', { error: String(err) });
  }

  console.log('Configuring secrets...');
  const bootstrapState = createState();
  initializeStateSecrets(bootstrapState);
  writeSystemEnv(bootstrapState);
  // Ensure the akm env:user file exists (empty 0600) so the assistant can
  // source it. Owned and edited directly by OpenPalm — see akm-user-env.ts.
  ensureAkmUserEnv(bootstrapState);

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
  const port = Number(process.env.OP_HOST_UI_PORT) || DEFAULT_UI_PORT;
  console.log(`Setup wizard: http://localhost:${port}/setup`);
  const { startUIServer } = await import('../lib/ui-server.ts');
  await startUIServer({ open: !noOpen, port });
}

async function runFileInstall(filePath: string, noStart: boolean, explicitImageTag?: string): Promise<void> {
  console.log(`Reading setup config from ${filePath}...`);
  if (!(await Bun.file(filePath).exists())) {
    throw new Error(`Setup config file not found: ${filePath}. Check the --file path and try again.`);
  }
  const config = await parseConfigFile(filePath, await Bun.file(filePath).text());

  if (config.version !== 2) throw new Error('Setup config must be version 2. See example.spec.yaml for the format.');
  if ('spec' in config || 'capabilities' in config) {
    throw new Error('Setup config must use the modern flat shape (`llm`, `embedding`, `security`, `connections`) — legacy `spec`/`capabilities` forms are no longer supported.');
  }

  // A deliberate --version pins the image tag; thread it into the spec so
  // performSetup writes it. With no --version (and no spec imageTag),
  // performSetup defaults OP_IMAGE_TAG to `latest` rather than the host version.
  if (explicitImageTag && !(config as { imageTag?: string }).imageTag) {
    (config as { imageTag?: string }).imageTag = explicitImageTag;
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

  // Persist intentional non-secret runtime overrides from the install shell so
  // a later `openpalm start` reuses the same isolated project/port shape instead
  // of falling back to the live-stack defaults.
  const runtimeOverrides = Object.fromEntries(
    [
      'OP_PROJECT_NAME',
      'OP_ASSISTANT_PORT',
      'OP_HOST_UI_PORT',
      'OP_HOST_CLIENT_PORT',
      'OP_CLIENT_PORT',
    ].flatMap((key) => {
      const value = process.env[key]?.trim();
      return value ? [[key, value]] : [];
    }),
  );
  patchSecretsEnvFile(process.env.OP_HOME ?? resolveOpenPalmHome(), runtimeOverrides);

  console.log('Setup complete.');
  if (noStart) { console.log('Config written. Run `openpalm start` to start services.'); return; }
  await requireDocker();
  await deployServices('install');
}
