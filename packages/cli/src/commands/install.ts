import { defineCommand } from 'citty';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import cliPkg from '../../package.json' with { type: 'json' };
import { defaultConfigHome, defaultDataHome, defaultStateHome, defaultWorkDir } from '../lib/paths.ts';
import { ensureSecrets, ensureStackEnv } from '../lib/env.ts';
import { ADMIN_URL, isStackRunning, adminRequest, waitForAdminHealthy } from '../lib/admin.ts';
import { ensureDirectoryTree, fetchAsset, runDockerCompose, composeProjectArgs, ensureOpenCodeConfig, ensureOpenCodeSystemConfig, openBrowser } from '../lib/docker.ts';
import { ensureVarlock, prepareVarlockDir } from '../lib/varlock.ts';
import { detectHostInfo } from '../lib/host-info.ts';
import { loadAdminToken } from '../lib/env.ts';

const DEFAULT_INSTALL_REF = cliPkg.version ? `v${cliPkg.version}` : 'main';

export default defineCommand({
  meta: {
    name: 'install',
    description: 'Bootstrap XDG dirs, download assets, start admin + docker-socket-proxy, open setup wizard',
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
    if (await isStackRunning()) {
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

  const secretsSchemaContent = await fetchAsset(options.version, 'secrets.env.schema');
  const stackSchemaContent = await fetchAsset(options.version, 'stack.env.schema');
  await Bun.write(join(stateHome, 'artifacts', 'secrets.env.schema'), secretsSchemaContent);
  await Bun.write(join(stateHome, 'artifacts', 'stack.env.schema'), stackSchemaContent);

  await ensureSecrets(configHome);
  await ensureStackEnv(configHome, dataHome, stateHome, workDir, options.version);
  await ensureOpenCodeConfig(configHome);
  await ensureOpenCodeSystemConfig(dataHome);

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

  await runDockerCompose([
    ...composeProjectArgs(),
    'up',
    '-d',
    'docker-socket-proxy',
    'admin',
  ]);

  await waitForAdminHealthy();
  const targetUrl = updateMode ? `${ADMIN_URL}/` : `${ADMIN_URL}/setup`;
  if (!options.noOpen) {
    await openBrowser(targetUrl);
  }

  console.log(JSON.stringify({ ok: true, mode: updateMode ? 'update' : 'install', url: targetUrl }, null, 2));
}
