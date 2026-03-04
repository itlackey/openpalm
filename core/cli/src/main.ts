#!/usr/bin/env bun
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const ADMIN_URL = process.env.OPENPALM_ADMIN_API_URL || 'http://localhost:8100';
const REPO_OWNER = 'itlackey';
const REPO_NAME = 'openpalm';

type Command =
  | 'install'
  | 'uninstall'
  | 'update'
  | 'start'
  | 'stop'
  | 'restart'
  | 'logs'
  | 'status'
  | 'service';

const COMMANDS: readonly Command[] = ['install', 'uninstall', 'update', 'start', 'stop', 'restart', 'logs', 'status', 'service'];

type InstallOptions = {
  force: boolean;
  version: string;
  noStart: boolean;
  noOpen: boolean;
};

function defaultConfigHome(): string {
  return process.env.OPENPALM_CONFIG_HOME || join(homedir(), '.config', 'openpalm');
}

function defaultDataHome(): string {
  return process.env.OPENPALM_DATA_HOME || join(homedir(), '.local', 'share', 'openpalm');
}

function defaultStateHome(): string {
  return process.env.OPENPALM_STATE_HOME || join(homedir(), '.local', 'state', 'openpalm');
}

function defaultWorkDir(): string {
  return process.env.OPENPALM_WORK_DIR || join(homedir(), 'openpalm');
}

async function loadAdminToken(): Promise<string> {
  if (process.env.OPENPALM_ADMIN_TOKEN) {
    return process.env.OPENPALM_ADMIN_TOKEN;
  }

  const secretsPath = join(defaultConfigHome(), 'secrets.env');
  try {
    const text = await Bun.file(secretsPath).text();
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [key, ...rest] = line.split('=');
      if (key === 'ADMIN_TOKEN') {
        const value = rest.join('=').trim();
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
          return value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {
    // Best effort only.
  }

  return '';
}

async function adminRequest(path: string, init?: RequestInit): Promise<unknown> {
  const token = await loadAdminToken();
  const response = await fetch(`${ADMIN_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-By': 'cli',
      ...(token ? { 'X-Admin-Token': token } : {}),
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(120_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  if (!text) return { ok: true };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function printUsage(): void {
  console.log('Usage: openpalm <command> [args]');
  console.log('');
  console.log('Commands:');
  console.log('  install              Install and start the OpenPalm stack');
  console.log('  uninstall            Stop and remove OpenPalm');
  console.log('  update               Pull latest images and recreate containers');
  console.log('  start [service...]   Start services');
  console.log('  stop [service...]    Stop services');
  console.log('  restart [service...] Restart services');
  console.log('  logs [service...]    View container logs');
  console.log('  status               Show container status');
  console.log('  service              Service lifecycle operations');
}

function parseInstallOptions(args: string[]): InstallOptions {
  let force = false;
  let version = 'main';
  let noStart = false;
  let noOpen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--version') {
      const value = args[index + 1];
      if (!value) throw new Error('--version requires a value');
      version = value;
      index += 1;
      continue;
    }
    if (arg === '--no-start') {
      noStart = true;
      continue;
    }
    if (arg === '--no-open') {
      noOpen = true;
      continue;
    }
  }

  return { force, version, noStart, noOpen };
}

async function isStackRunning(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:8100/health', {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchAsset(repoRef: string, filename: string): Promise<string> {
  const releaseUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${repoRef}/${filename}`;
  const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${repoRef}/core/assets/${filename}`;

  const releaseResponse = await fetch(releaseUrl, { signal: AbortSignal.timeout(30000) });
  if (releaseResponse.ok) {
    return await releaseResponse.text();
  }

  const rawResponse = await fetch(rawUrl, { signal: AbortSignal.timeout(30000) });
  if (rawResponse.ok) {
    return await rawResponse.text();
  }

  throw new Error(`Failed to download ${filename} from ${repoRef}`);
}

async function ensureDirectoryTree(configHome: string, dataHome: string, stateHome: string, workDir: string): Promise<void> {
  const dirs = [
    configHome,
    join(configHome, 'channels'),
    join(configHome, 'opencode'),
    join(configHome, 'automations'),
    dataHome,
    join(dataHome, 'openmemory'),
    join(dataHome, 'assistant'),
    join(dataHome, 'guardian'),
    join(dataHome, 'caddy'),
    join(dataHome, 'caddy', 'data'),
    join(dataHome, 'caddy', 'config'),
    join(dataHome, 'automations'),
    stateHome,
    join(stateHome, 'artifacts'),
    join(stateHome, 'audit'),
    join(stateHome, 'artifacts', 'channels'),
    join(stateHome, 'automations'),
    workDir,
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

async function ensureSecrets(configHome: string): Promise<void> {
  const secretsPath = join(configHome, 'secrets.env');
  if (await Bun.file(secretsPath).exists()) {
    return;
  }

  const userId = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'default_user';
  const content = `# OpenPalm Secrets — generated by openpalm install\n# All values are configured via the setup wizard.\n\nADMIN_TOKEN=\n\n# OpenAI-compatible LLM provider (configured via setup wizard)\nOPENAI_API_KEY=\nOPENAI_BASE_URL=\n# GROQ_API_KEY=\n# MISTRAL_API_KEY=\n# GOOGLE_API_KEY=\n\n# OpenMemory\nOPENMEMORY_USER_ID=${userId}\n`;

  await Bun.write(secretsPath, content);
}

async function ensureStackEnv(configHome: string, dataHome: string, stateHome: string, workDir: string): Promise<void> {
  const dataStackEnv = join(dataHome, 'stack.env');
  const stagedStackEnv = join(stateHome, 'artifacts', 'stack.env');
  if (!(await Bun.file(dataStackEnv).exists())) {
    const content = `# OpenPalm Stack Bootstrap — system-managed, do not edit\nOPENPALM_CONFIG_HOME=${configHome}\nOPENPALM_DATA_HOME=${dataHome}\nOPENPALM_STATE_HOME=${stateHome}\nOPENPALM_WORK_DIR=${workDir}\nOPENPALM_UID=${process.getuid?.() ?? 1000}\nOPENPALM_GID=${process.getgid?.() ?? 1000}\nOPENPALM_DOCKER_SOCK=/var/run/docker.sock\nOPENPALM_IMAGE_NAMESPACE=${process.env.OPENPALM_IMAGE_NAMESPACE || 'openpalm'}\nOPENPALM_IMAGE_TAG=${process.env.OPENPALM_IMAGE_TAG || 'latest'}\n`;
    await Bun.write(dataStackEnv, content);
  }
  await Bun.write(stagedStackEnv, Bun.file(dataStackEnv));

  const stateSecrets = join(stateHome, 'artifacts', 'secrets.env');
  await Bun.write(stateSecrets, Bun.file(join(configHome, 'secrets.env')));
}

async function ensureOpenCodeConfig(configHome: string): Promise<void> {
  const opencodeDir = join(configHome, 'opencode');
  const configFile = join(opencodeDir, 'opencode.json');
  if (!(await Bun.file(configFile).exists())) {
    await Bun.write(configFile, '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
  }
  await mkdir(join(opencodeDir, 'tools'), { recursive: true });
  await mkdir(join(opencodeDir, 'plugins'), { recursive: true });
  await mkdir(join(opencodeDir, 'skills'), { recursive: true });
}

async function runDockerCompose(args: string[]): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed with exit code ${code}`);
  }
}

async function waitForAdminHealthy(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (await isStackRunning()) {
      return;
    }
    await Bun.sleep(3000);
  }
  throw new Error('Admin did not become healthy within 120 seconds');
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' });
      return;
    }
    if (platform === 'win32') {
      Bun.spawn(['cmd', '/c', 'start', url], { stdout: 'ignore', stderr: 'ignore' });
      return;
    }
    Bun.spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // Best effort
  }
}

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

  const composeContent = await fetchAsset(options.version, 'docker-compose.yml');
  const caddyContent = await fetchAsset(options.version, 'Caddyfile');
  await Bun.write(join(dataHome, 'docker-compose.yml'), composeContent);
  await Bun.write(join(dataHome, 'caddy', 'Caddyfile'), caddyContent);
  await Bun.write(join(stateHome, 'artifacts', 'docker-compose.yml'), composeContent);
  await Bun.write(join(stateHome, 'artifacts', 'Caddyfile'), caddyContent);

  await ensureSecrets(configHome);
  await ensureStackEnv(configHome, dataHome, stateHome, workDir);
  await ensureOpenCodeConfig(configHome);

  if (options.noStart) {
    console.log('OpenPalm files prepared. Run `openpalm start` to start services.');
    return;
  }

  await runDockerCompose([
    '--project-name',
    'openpalm',
    '-f',
    join(stateHome, 'artifacts', 'docker-compose.yml'),
    '--env-file',
    join(configHome, 'secrets.env'),
    '--env-file',
    join(stateHome, 'artifacts', 'stack.env'),
    'up',
    '-d',
    'docker-socket-proxy',
    'admin',
  ]);

  await waitForAdminHealthy();
  const targetUrl = updateMode ? 'http://localhost:8100/' : 'http://localhost:8100/setup';
  if (!options.noOpen) {
    await openBrowser(targetUrl);
  }

  console.log(JSON.stringify({ ok: true, mode: updateMode ? 'update' : 'install', url: targetUrl }, null, 2));
}

async function runInstall(args: string[]): Promise<void> {
  const options = parseInstallOptions(args);
  if (await isStackRunning()) {
    console.log(JSON.stringify(await adminRequest('/admin/install', { method: 'POST' }), null, 2));
    return;
  }

  await bootstrapInstall(options);
}

async function runComposeLogs(services: string[]): Promise<void> {
  const stateHome = defaultStateHome();
  const configHome = defaultConfigHome();

  const composeArgs = [
    'compose',
    '--project-name',
    'openpalm',
    '-f',
    join(stateHome, 'artifacts', 'docker-compose.yml'),
    '--env-file',
    join(configHome, 'secrets.env'),
    '--env-file',
    join(stateHome, 'artifacts', 'stack.env'),
    'logs',
    '--tail',
    '100',
    ...services,
  ];

  const proc = Bun.spawn(['docker', ...composeArgs], { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Docker compose logs command failed (exit code ${exitCode})`);
  }
}

async function runServiceAction(action: 'up' | 'down' | 'restart', services: string[]): Promise<void> {
  if (services.length === 0) {
    if (action === 'up') {
      console.log(JSON.stringify(await adminRequest('/admin/install', { method: 'POST' }), null, 2));
      return;
    }
    if (action === 'down') {
      console.log(JSON.stringify(await adminRequest('/admin/uninstall', { method: 'POST' }), null, 2));
      return;
    }
    const status = await adminRequest('/admin/containers/list');
    const serviceNames = getServiceNames(status);
    for (const service of serviceNames) {
      const result = await adminRequest('/admin/containers/restart', {
        method: 'POST',
        body: JSON.stringify({ service }),
      });
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  const endpoint = action === 'up' ? '/admin/containers/up' : action === 'down' ? '/admin/containers/down' : '/admin/containers/restart';

  for (const service of services) {
    const result = await adminRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify({ service }),
    });
    console.log(JSON.stringify(result, null, 2));
  }
}

function getServiceNames(status: unknown): string[] {
  if (!status || typeof status !== 'object' || !('containers' in status)) {
    return [];
  }
  const containers = (status as { containers?: unknown }).containers;
  if (!containers || typeof containers !== 'object') {
    return [];
  }
  return Object.keys(containers as Record<string, unknown>);
}

async function runServiceCommand(args: string[]): Promise<void> {
  const [subcommand, ...services] = args;
  if (!subcommand) {
    throw new Error('Missing subcommand. Usage: openpalm service <start|stop|restart|logs|update|status> [service...]');
  }

  if (subcommand === 'start' || subcommand === 'up') {
    await runServiceAction('up', services);
    return;
  }
  if (subcommand === 'stop' || subcommand === 'down') {
    await runServiceAction('down', services);
    return;
  }
  if (subcommand === 'restart') {
    await runServiceAction('restart', services);
    return;
  }
  if (subcommand === 'logs') {
    await runComposeLogs(services);
    return;
  }
  if (subcommand === 'update') {
    console.log(JSON.stringify(await adminRequest('/admin/containers/pull', { method: 'POST' }), null, 2));
    return;
  }
  if (subcommand === 'status') {
    console.log(JSON.stringify(await adminRequest('/admin/containers/list'), null, 2));
    return;
  }

  throw new Error(`Unknown subcommand: ${subcommand}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [rawCommand, ...args] = argv;

  if (!rawCommand || rawCommand === 'help' || rawCommand === '--help' || rawCommand === '-h') {
    printUsage();
    return;
  }
  if (!COMMANDS.includes(rawCommand as Command)) {
    throw new Error(`Unknown command: ${rawCommand}`);
  }

  const command = rawCommand;

  if (command === 'install') {
    await runInstall(args);
    return;
  }

  if (command === 'uninstall') {
    console.log(JSON.stringify(await adminRequest('/admin/uninstall', { method: 'POST' }), null, 2));
    return;
  }

  if (command === 'update') {
    console.log(JSON.stringify(await adminRequest('/admin/containers/pull', { method: 'POST' }), null, 2));
    return;
  }

  if (command === 'start') {
    await runServiceAction('up', args);
    return;
  }

  if (command === 'stop') {
    await runServiceAction('down', args);
    return;
  }

  if (command === 'restart') {
    await runServiceAction('restart', args);
    return;
  }

  if (command === 'logs') {
    await runComposeLogs(args);
    return;
  }

  if (command === 'status') {
    console.log(JSON.stringify(await adminRequest('/admin/containers/list'), null, 2));
    return;
  }

  if (command === 'service') {
    await runServiceCommand(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
