#!/usr/bin/env bun
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const ADMIN_URL = process.env.OPENPALM_ADMIN_API_URL || 'http://localhost:8100';
const REPO_OWNER = 'itlackey';
const REPO_NAME = 'openpalm';

const IS_WINDOWS = process.platform === 'win32';

// Single source of truth for the pinned varlock version and its SHA-256 checksum.
const VARLOCK_VERSION = '0.4.0';
const VARLOCK_SHA256 = '820295b271cece2679b2b9701b5285ce39354fc2f35797365fa36c70125f51ab';

type Command =
  | 'install'
  | 'uninstall'
  | 'update'
  | 'start'
  | 'stop'
  | 'restart'
  | 'logs'
  | 'status'
  | 'service'
  | 'validate';

const COMMANDS: readonly Command[] = ['install', 'uninstall', 'update', 'start', 'stop', 'restart', 'logs', 'status', 'service', 'validate'];

type InstallOptions = {
  force: boolean;
  version: string;
  noStart: boolean;
  noOpen: boolean;
};

export interface HostInfo {
  platform: string;
  arch: string;
  docker: { available: boolean; running: boolean };
  ollama: { running: boolean; url: string };
  lmstudio: { running: boolean; url: string };
  llamacpp: { running: boolean; url: string };
  timestamp: string;
}

function defaultConfigHome(): string {
  if (process.env.OPENPALM_CONFIG_HOME) return process.env.OPENPALM_CONFIG_HOME;
  if (IS_WINDOWS) {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'openpalm');
  }
  return join(homedir(), '.config', 'openpalm');
}

function defaultDataHome(): string {
  if (process.env.OPENPALM_DATA_HOME) return process.env.OPENPALM_DATA_HOME;
  if (IS_WINDOWS) {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'openpalm', 'data');
  }
  return join(homedir(), '.local', 'share', 'openpalm');
}

function defaultStateHome(): string {
  if (process.env.OPENPALM_STATE_HOME) return process.env.OPENPALM_STATE_HOME;
  if (IS_WINDOWS) {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'openpalm', 'state');
  }
  return join(homedir(), '.local', 'state', 'openpalm');
}

function defaultDockerSock(): string {
  if (process.env.OPENPALM_DOCKER_SOCK) return process.env.OPENPALM_DOCKER_SOCK;
  return IS_WINDOWS ? '//./pipe/docker_engine' : '/var/run/docker.sock';
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
  console.log('  validate              Validate configuration against schema');
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
  const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${repoRef}/assets/${filename}`;

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
    join(configHome, 'assistant'),
    join(configHome, 'automations'),
    dataHome,
    join(dataHome, 'memory'),
    join(dataHome, 'assistant'),
    join(dataHome, 'guardian'),
    join(dataHome, 'caddy'),
    join(dataHome, 'caddy', 'data'),
    join(dataHome, 'caddy', 'config'),
    join(dataHome, 'automations'),
    join(dataHome, 'opencode'),
    stateHome,
    join(stateHome, 'artifacts'),
    join(stateHome, 'audit'),
    join(stateHome, 'artifacts', 'channels'),
    join(stateHome, 'automations'),
    join(stateHome, 'opencode'),
    join(stateHome, 'bin'),
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
  const content = `# OpenPalm Secrets — generated by openpalm install\n# All values are configured via the setup wizard.\n\nADMIN_TOKEN=\n\n# LLM provider keys (configure at least one via the setup wizard)\nOPENAI_API_KEY=\nOPENAI_BASE_URL=\n# ANTHROPIC_API_KEY=\n# GROQ_API_KEY=\n# MISTRAL_API_KEY=\n# GOOGLE_API_KEY=\n\n# Memory\nMEMORY_USER_ID=${userId}\n`;

  await Bun.write(secretsPath, content);
}

async function ensureStackEnv(configHome: string, dataHome: string, stateHome: string, workDir: string): Promise<void> {
  const dataStackEnv = join(dataHome, 'stack.env');
  const stagedStackEnv = join(stateHome, 'artifacts', 'stack.env');
  if (!(await Bun.file(dataStackEnv).exists())) {
    const content = `# OpenPalm Stack Bootstrap — system-managed, do not edit\nOPENPALM_CONFIG_HOME=${configHome}\nOPENPALM_DATA_HOME=${dataHome}\nOPENPALM_STATE_HOME=${stateHome}\nOPENPALM_WORK_DIR=${workDir}\nOPENPALM_UID=${process.getuid?.() ?? 1000}\nOPENPALM_GID=${process.getgid?.() ?? 1000}\nOPENPALM_DOCKER_SOCK=${defaultDockerSock()}\nOPENPALM_IMAGE_NAMESPACE=${process.env.OPENPALM_IMAGE_NAMESPACE || 'openpalm'}\nOPENPALM_IMAGE_TAG=${process.env.OPENPALM_IMAGE_TAG || 'latest'}\n`;
    await Bun.write(dataStackEnv, content);
  }
  await Bun.write(stagedStackEnv, Bun.file(dataStackEnv));

  const stateSecrets = join(stateHome, 'artifacts', 'secrets.env');
  await Bun.write(stateSecrets, Bun.file(join(configHome, 'secrets.env')));
}

async function ensureOpenCodeConfig(configHome: string): Promise<void> {
  const opencodeDir = join(configHome, 'assistant');
  const configFile = join(opencodeDir, 'opencode.json');
  if (!(await Bun.file(configFile).exists())) {
    await Bun.write(configFile, '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
  }
  await mkdir(join(opencodeDir, 'tools'), { recursive: true });
  await mkdir(join(opencodeDir, 'plugins'), { recursive: true });
  await mkdir(join(opencodeDir, 'skills'), { recursive: true });
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) {
    const existing = await file.text();
    if (existing === content) {
      return;
    }
  }
  await Bun.write(path, content);
}

async function ensureOpenCodeSystemConfig(dataHome: string): Promise<void> {
  const opencodeSystemDir = join(dataHome, 'assistant');
  await mkdir(opencodeSystemDir, { recursive: true });

  const systemConfig = join(opencodeSystemDir, 'opencode.jsonc');
  const systemConfigContent =
    JSON.stringify(
      {
        "$schema": "https://opencode.ai/config.json",
        "plugin": ["@openpalm/assistant-tools", "@itlackey/openkit"]
      },
      null,
      2,
    ) + "\n";
  await writeIfChanged(systemConfig, systemConfigContent);

  const agentsFile = join(opencodeSystemDir, 'AGENTS.md');
  const assetsAgentsPath = join(import.meta.dir, '..', '..', 'assets', 'AGENTS.md');
  let agentsContent: string;
  if (await Bun.file(assetsAgentsPath).exists()) {
    agentsContent = await Bun.file(assetsAgentsPath).text();
  } else {
    agentsContent =
      '# OpenPalm Assistant\n\n' +
      'This file defines the assistant persona.\n' +
      'It is seeded by the CLI on first install and managed by the admin on subsequent updates.\n';
  }
  await writeIfChanged(agentsFile, agentsContent);
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

/**
 * Downloads varlock binary via install script and caches it in STATE_HOME/bin/.
 * Skips download if binary already exists.
 *
 * @param stateHome - Path to STATE_HOME directory
 * @returns Absolute path to the varlock binary
 */
async function ensureVarlock(stateHome: string): Promise<string> {
  const binDir = join(stateHome, 'bin');
  const varlockBin = join(binDir, 'varlock');

  if (await Bun.file(varlockBin).exists()) {
    return varlockBin;
  }

  await mkdir(binDir, { recursive: true });

  const tarballUrl = `https://github.com/dmno-dev/varlock/releases/download/varlock%40${VARLOCK_VERSION}/varlock-linux-x64.tar.gz`;
  const tarballPath = join(binDir, 'varlock.tar.gz');

  // Download pinned tarball using argument array (no shell string interpolation).
  const downloadProc = Bun.spawn(
    ['curl', '-fsSL', '--retry', '5', '--retry-delay', '10', '--retry-all-errors', tarballUrl, '-o', tarballPath],
    {
      env: { HOME: process.env.HOME ?? '' },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const downloadCode = await downloadProc.exited;
  if (downloadCode !== 0) {
    throw new Error(`Failed to download varlock tarball (curl exited with code ${downloadCode})`);
  }

  // Verify SHA-256 integrity before extracting.
  const hashProc = Bun.spawn(
    ['sh', '-c', `echo "${VARLOCK_SHA256}  ${tarballPath}" | sha256sum -c -`],
    {
      env: { HOME: process.env.HOME ?? '' },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const hashCode = await hashProc.exited;
  if (hashCode !== 0) {
    // Remove the suspect file before throwing.
    const rmProc = Bun.spawn(['rm', '-f', tarballPath], { env: {} });
    await rmProc.exited;
    throw new Error(`varlock tarball SHA-256 verification failed — download may be corrupted`);
  }

  // Extract the binary.
  const extractProc = Bun.spawn(
    ['tar', 'xzf', tarballPath, '--strip-components=1', '-C', binDir],
    {
      env: { HOME: process.env.HOME ?? '' },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const extractCode = await extractProc.exited;
  if (extractCode !== 0) {
    throw new Error(`Failed to extract varlock tarball (tar exited with code ${extractCode})`);
  }

  // Remove tarball after extraction.
  const rmProc = Bun.spawn(['rm', '-f', tarballPath], { env: {} });
  await rmProc.exited;

  // Set executable bit.
  const chmodProc = Bun.spawn(['chmod', '+x', varlockBin], { env: {} });
  await chmodProc.exited;

  if (!(await Bun.file(varlockBin).exists())) {
    throw new Error(`varlock binary not found at ${varlockBin} after install`);
  }

  return varlockBin;
}

/**
 * Detects host system information including platform, Docker availability,
 * and local AI service endpoints.
 */
export async function detectHostInfo(): Promise<HostInfo> {
  // Docker detection
  const dockerAvailable = Boolean(Bun.which('docker'));
  let dockerRunning = false;
  if (dockerAvailable) {
    const proc = Bun.spawn(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' });
    dockerRunning = (await proc.exited) === 0;
  }

  // HTTP probes for local AI services
  async function probeHttp(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  const [ollamaRunning, lmstudioRunning, llamacppRunning] = await Promise.all([
    probeHttp('http://localhost:11434/api/tags'),
    probeHttp('http://localhost:1234/v1/models'),
    probeHttp('http://localhost:8080/health'),
  ]);

  return {
    platform: process.platform,
    arch: process.arch,
    docker: { available: dockerAvailable, running: dockerRunning },
    ollama: { running: ollamaRunning, url: 'http://localhost:11434' },
    lmstudio: { running: lmstudioRunning, url: 'http://localhost:1234' },
    llamacpp: { running: llamacppRunning, url: 'http://localhost:8080' },
    timestamp: new Date().toISOString(),
  };
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
  await ensureStackEnv(configHome, dataHome, stateHome, workDir);
  await ensureOpenCodeConfig(configHome);
  await ensureOpenCodeSystemConfig(dataHome);

  // Non-fatal validation
  try {
    const varlockBin = await ensureVarlock(stateHome);
    const schemaPath = join(stateHome, 'artifacts', 'secrets.env.schema');
    const envPath = join(configHome, 'secrets.env');
    if (await Bun.file(schemaPath).exists()) {
      const proc = Bun.spawn([varlockBin, 'load', '--schema', schemaPath, '--env-file', envPath, '--quiet'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const code = await proc.exited;
      if (code === 0) {
        console.log('Configuration validated.');
      } else {
        console.warn('Configuration has validation warnings (non-fatal on first install).');
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

async function runValidate(args: string[]): Promise<void> {
  void args; // reserved for future flags
  const stateHome = defaultStateHome();
  const configHome = defaultConfigHome();
  const varlockBin = await ensureVarlock(stateHome);

  const primarySchema = join(stateHome, 'artifacts', 'secrets.env.schema');
  const fallbackSchema = join(stateHome, 'artifacts', 'stack.env.schema');
  const envPath = join(configHome, 'secrets.env');

  const schemaPath = (await Bun.file(primarySchema).exists()) ? primarySchema : fallbackSchema;

  const proc = Bun.spawn(
    [varlockBin, 'load', '--schema', schemaPath, '--env-file', envPath],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  const code = await proc.exited;
  process.exit(code);
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

  if (command === 'validate') {
    await runValidate(args);
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
