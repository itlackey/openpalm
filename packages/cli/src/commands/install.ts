import { defineCommand } from 'citty';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultHomeDir, defaultConfigDir, defaultVaultDir, defaultDataDir, defaultWorkDir } from '../lib/paths.ts';
import { ensureSecrets, ensureStackEnv, resolveRequestedImageTag } from '../lib/env.ts';
import { ensureDirectoryTree, fetchAsset, openBrowser } from '../lib/docker.ts';
import {
  ensureOpenCodeConfig, ensureOpenCodeSystemConfig,
  performSetup,
  type SetupSpec, type SetupResult,
  formatCapabilityString,
  EMBEDDING_DIMS,
} from '@openpalm/lib';
import type { StackSpec, StackSpecCapabilities, StackSpecAddonValue } from '@openpalm/lib';
import { ensureVarlock, prepareVarlockDir } from '../lib/varlock.ts';
import { detectHostInfo } from '../lib/host-info.ts';
import { ensureValidState } from '../lib/cli-state.ts';
import { buildManagedServiceNames, runComposeWithPreflight } from '../lib/cli-compose.ts';
import { createSetupServer } from '../setup-wizard/server.ts';
import { buildInstallServiceNames, buildDeployStatusEntries } from './install-services.ts';

const SETUP_WIZARD_PORT = Number(process.env.OP_SETUP_PORT) || 8100;

const REPO_OWNER = 'itlackey';
const REPO_NAME = 'openpalm';

/**
 * Resolves the latest release tag from GitHub. Falls back to the CLI package
 * version (prefixed with 'v') so the install never silently defaults to 'main'
 * which produces an un-pinned 'latest' image tag.
 */
async function resolveDefaultInstallRef(): Promise<string> {
  try {
    const res = await fetch(
      `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      { redirect: 'manual', signal: AbortSignal.timeout(10000) },
    );
    const location = res.headers.get('location') ?? '';
    const match = location.match(/\/tag\/(v[0-9]+\.[0-9]+\.[0-9]+[^\s]*)$/);
    if (match?.[1]) return match[1];
  } catch {
    // Network error — fall through to package version
  }
  return cliPkg.version ? `v${cliPkg.version}` : 'main';
}

/**
 * Migrate a v1 SetupConfig to a SetupSpec.
 * Handles the v1 -> v2 shape transformation.
 */
function migrateSetupConfigToSetupSpec(config: Record<string, unknown>): SetupSpec {
  const security = config.security as { adminToken: string };
  const owner = config.owner as { name?: string; email?: string } | undefined;
  const connections = config.connections as Array<{
    id: string; name: string; provider: string; baseUrl: string; apiKey: string;
  }>;
  const assignments = config.assignments as {
    llm: { connectionId: string; model: string; smallModel?: string };
    embeddings: { connectionId: string; model: string; embeddingDims?: number };
    tts?: unknown;
    stt?: unknown;
  };
  const memory = config.memory as { userId?: string } | undefined;
  const channels = config.channels as Record<string, boolean | Record<string, unknown>> | undefined;
  const services = config.services as Record<string, boolean | { enabled: boolean }> | undefined;

  // Resolve connections by ID
  const llmConn = connections.find(c => c.id === assignments.llm.connectionId);
  const embConn = connections.find(c => c.id === assignments.embeddings.connectionId);

  if (!llmConn) throw new Error(`LLM connection "${assignments.llm.connectionId}" not found`);
  if (!embConn) throw new Error(`Embeddings connection "${assignments.embeddings.connectionId}" not found`);

  // Build capabilities
  const embLookupKey = `${embConn.provider}/${assignments.embeddings.model}`;
  const resolvedDims = assignments.embeddings.embeddingDims || EMBEDDING_DIMS[embLookupKey] || 1536;

  const capabilities: StackSpecCapabilities = {
    llm: formatCapabilityString(llmConn.provider, assignments.llm.model),
    ...(assignments.llm.smallModel
      ? { slm: formatCapabilityString(llmConn.provider, assignments.llm.smallModel) }
      : {}),
    embeddings: {
      provider: embConn.provider,
      model: assignments.embeddings.model || 'text-embedding-3-small',
      dims: resolvedDims,
    },
    memory: {
      userId: memory?.userId || 'default_user',
      customInstructions: '',
    },
  };

  // Build addons
  const addons: Record<string, StackSpecAddonValue> = {};
  const ollamaEnabled = services && ('ollama' in services)
    ? (typeof services.ollama === 'boolean' ? services.ollama : services.ollama.enabled)
    : false;
  if (ollamaEnabled) addons.ollama = true;
  if (services) {
    if (typeof services.admin === 'boolean' ? services.admin : (services.admin as { enabled: boolean })?.enabled) {
      addons.admin = true;
    }
    if (typeof services.openviking === 'boolean' ? services.openviking : (services.openviking as { enabled: boolean })?.enabled) {
      addons.openviking = true;
    }
  }
  if (channels) {
    for (const [id, value] of Object.entries(channels)) {
      if (value === true) {
        addons[id] = true;
      } else if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        if (obj.enabled !== false) {
          addons[id] = true;
        }
      }
    }
  }

  // Build channel credentials from channels
  const channelCredentials: Record<string, Record<string, string>> = {};
  if (channels) {
    for (const [id, value] of Object.entries(channels)) {
      if (typeof value !== 'object' || value === null) continue;
      const creds = value as Record<string, unknown>;
      const mapped: Record<string, string> = {};
      for (const [key, val] of Object.entries(creds)) {
        if (key === 'enabled') continue;
        if (typeof val === 'string' && val) {
          mapped[key] = val;
        } else if (typeof val === 'boolean') {
          mapped[key] = String(val);
        }
      }
      if (Object.keys(mapped).length > 0) {
        channelCredentials[id] = mapped;
      }
    }
  }

  const spec: StackSpec = {
    version: 2,
    capabilities,
    addons,
  };

  return {
    spec,
    security,
    owner,
    connections,
    ...(Object.keys(channelCredentials).length > 0 ? { channelCredentials } : {}),
  };
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

  const homeDir = defaultHomeDir();
  const configDir = defaultConfigDir();
  const vaultDir = defaultVaultDir();
  const dataDir = defaultDataDir();
  const workDir = defaultWorkDir();

  const secretsPath = join(vaultDir, 'user', 'user.env');
  const updateMode = await Bun.file(secretsPath).exists();
  if (updateMode && !options.force) {
    throw new Error('OpenPalm appears to already be installed. Re-run install with --force to continue.');
  }

  await ensureDirectoryTree(homeDir, configDir, vaultDir, dataDir, workDir);

  // Detect host system info (non-fatal)
  try {
    const hostInfo = await detectHostInfo();
    await Bun.write(join(dataDir, 'host.json'), JSON.stringify(hostInfo, null, 2) + '\n');
  } catch {
    // Host detection failure is non-fatal
  }

  const composeContent = await fetchAsset(options.version, '.openpalm/stack/core.compose.yml');
  await Bun.write(join(homeDir, 'stack', 'core.compose.yml'), composeContent);

  // Download schemas to vault/ for varlock validation and dataDir for FilesystemAssetProvider
  for (const [remoteFile, localPath] of [
    ['.openpalm/vault/user/user.env.schema', join(vaultDir, 'user', 'user.env.schema')],
    ['.openpalm/vault/stack/stack.env.schema', join(vaultDir, 'stack', 'stack.env.schema')],
  ] as const) {
    try {
      const content = await fetchAsset(options.version, remoteFile);
      await Bun.write(localPath, content);
    } catch (err) {
      console.warn(`Warning: could not download schema '${remoteFile}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Download remaining assets needed by FilesystemAssetProvider
  const assetFiles: Array<{ remote: string; localPath: string }> = [
    { remote: '.openpalm/stack/addons/ollama/compose.yml', localPath: join(homeDir, 'stack', 'addons', 'ollama', 'compose.yml') },
    { remote: 'core/assistant/AGENTS.md', localPath: join(dataDir, 'assistant', 'AGENTS.md') },
    { remote: 'core/assistant/opencode.jsonc', localPath: join(dataDir, 'assistant', 'opencode.jsonc') },
    { remote: '.openpalm/config/automations/cleanup-logs.yml', localPath: join(configDir, 'automations', 'cleanup-logs.yml') },
    { remote: '.openpalm/config/automations/cleanup-data.yml', localPath: join(configDir, 'automations', 'cleanup-data.yml') },
    { remote: '.openpalm/config/automations/validate-config.yml', localPath: join(configDir, 'automations', 'validate-config.yml') },
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

  await ensureSecrets(vaultDir);
  // Derive the image tag from the resolved version so that stale or
  // architecture-suffixed OP_IMAGE_TAG env vars don't leak in.
  const imageTag = resolveRequestedImageTag(options.version) ?? undefined;
  await ensureStackEnv(homeDir, vaultDir, workDir, options.version, imageTag);
  // Seed OpenCode config — non-fatal since performSetup() also seeds these
  try {
    ensureOpenCodeConfig();
    ensureOpenCodeSystemConfig();
  } catch {
    // Assets may not be available yet on first install; performSetup() will retry
  }

  // Non-fatal validation
  try {
    const varlockBin = await ensureVarlock(dataDir);
    const schemaPath = join(vaultDir, 'user', 'user.env.schema');
    const envPath = join(vaultDir, 'user', 'user.env');
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
  // Read a JSON or YAML setup config file and call performSetup() directly.
  // Supports both v1 (SetupConfig, migrated) and v2 (SetupSpec).

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

    const config = parsed as Record<string, unknown>;
    let setupSpec: SetupSpec;

    if (typeof config.version !== "number") {
      throw new Error(
        `Setup config file is missing a 'version' field. Use 'version: 1' for the legacy format or include a 'spec' field for the new format.`
      );
    }

    if (config.version === 1) {
      // Migrate v1 SetupConfig to SetupSpec
      setupSpec = migrateSetupConfigToSetupSpec(config);
    } else if (config.spec !== undefined) {
      // Direct SetupSpec (no version field on the envelope, version is on spec)
      setupSpec = config as unknown as SetupSpec;
    } else {
      throw new Error(`Unsupported setup config version: ${config.version}. Use version 1 (legacy) or the new SetupSpec format.`);
    }

    const result = await performSetup(setupSpec);

    if (!result.ok) throw new Error(`Setup failed: ${result.error}`);
    console.log('Setup complete.');

    if (options.noStart) {
      console.log('Config written. Run `openpalm start` to start services.');
      return;
    }

    // Deploy (same as existing update-mode code)
    console.log('Starting services...');
    const state = await ensureValidState();
    const managedServices = await buildManagedServiceNames(state);
    const allServices = buildInstallServiceNames(managedServices);

    await runComposeWithPreflight(state, ['pull', ...allServices]).catch(() => {
      console.warn('Warning: image pull failed.');
    });
    await runComposeWithPreflight(state, ['up', '-d', ...allServices]);
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
      wizard = createSetupServer(SETUP_WIZARD_PORT, { configDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('EADDRINUSE') || msg.includes('address already in use') || msg.includes('Failed to start')) {
        throw new Error(`Port ${SETUP_WIZARD_PORT} is in use. Stop the conflicting process or set OP_SETUP_PORT=<port>.`);
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
      const state = await ensureValidState();
      const managedServices = await buildManagedServiceNames(state);
      const allServices = buildInstallServiceNames(managedServices);

      wizard.updateDeployStatus(buildDeployStatusEntries(allServices, 'pending', 'Waiting...'));

      await runComposeWithPreflight(state, ['pull', ...allServices]).catch(() => {
        console.warn('Warning: image pull failed — if this is your first install, check your network connection.');
      });

      wizard.updateDeployStatus(buildDeployStatusEntries(allServices, 'pulling', 'Starting...'));

      await runComposeWithPreflight(state, ['up', '-d', ...allServices]);

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

  const state = await ensureValidState();
  const managedServices = await buildManagedServiceNames(state);
  const allServices = buildInstallServiceNames(managedServices);

  await runComposeWithPreflight(state, ['up', '-d', ...allServices]);

  console.log(JSON.stringify({
    ok: true,
    mode: 'update',
    services: allServices,
  }, null, 2));
}
