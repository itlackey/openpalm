#!/usr/bin/env bun
import { homedir } from 'node:os';
import { join } from 'node:path';

const ADMIN_URL = process.env.OPENPALM_ADMIN_API_URL || 'http://localhost:8100';
const COMMANDS: readonly Command[] = ['install', 'uninstall', 'update', 'start', 'stop', 'restart', 'logs', 'status', 'service'];

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

function defaultConfigHome(): string {
  return process.env.OPENPALM_CONFIG_HOME || join(homedir(), '.config', 'openpalm');
}

function defaultStateHome(): string {
  return process.env.OPENPALM_STATE_HOME || join(homedir(), '.local', 'state', 'openpalm');
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
      if (key === 'ADMIN_TOKEN') return rest.join('=').trim();
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
    throw new Error(`Failed to fetch logs with docker compose (exit code ${exitCode})`);
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
    console.log(JSON.stringify(await adminRequest('/admin/install', { method: 'POST' }), null, 2));
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
