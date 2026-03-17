import { defineCommand } from 'citty';
import { tryAdminRequest } from '../lib/admin.ts';
import { runDockerCompose } from '../lib/docker.ts';
import { ensureStagedState, fullComposeArgs } from '../lib/staging.ts';
import { runLogsAction } from './logs.ts';
import { runStartAction } from './start.ts';
import { runStopAction } from './stop.ts';
import { runRestartAction } from './restart.ts';

const startCmd = defineCommand({
  meta: { name: 'start', description: 'Start services' },
  args: {
    services: { type: 'positional', description: 'Service names', required: false },
  },
  async run({ args }) { await runStartAction(args._ ?? []); },
});

const stopCmd = defineCommand({
  meta: { name: 'stop', description: 'Stop services' },
  args: {
    services: { type: 'positional', description: 'Service names', required: false },
  },
  async run({ args }) { await runStopAction(args._ ?? []); },
});

const restartCmd = defineCommand({
  meta: { name: 'restart', description: 'Restart services' },
  args: {
    services: { type: 'positional', description: 'Service names', required: false },
  },
  async run({ args }) { await runRestartAction(args._ ?? []); },
});

const logsCmd = defineCommand({
  meta: { name: 'logs', description: 'View service logs' },
  args: {
    services: { type: 'positional', description: 'Service names', required: false },
  },
  async run({ args }) { await runLogsAction(args._ ?? []); },
});

const updateCmd = defineCommand({
  meta: { name: 'update', description: 'Pull latest images' },
  async run() {
    // Try admin delegation first
    const adminResult = await tryAdminRequest('/admin/containers/pull', { method: 'POST' });
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      return;
    }

    // Direct compose pull + recreate
    const state = await ensureStagedState();
    const composeArgs = fullComposeArgs(state);
    console.log('Pulling latest images...');
    await runDockerCompose([...composeArgs, 'pull']);
    console.log('Recreating containers...');
    await runDockerCompose([...composeArgs, 'up', '-d', '--force-recreate']);
    console.log('Update complete.');
  },
});

const statusCmd = defineCommand({
  meta: { name: 'status', description: 'Show container status' },
  async run() {
    // Try admin delegation first
    const adminResult = await tryAdminRequest('/admin/containers/list');
    if (adminResult !== null) {
      console.log(JSON.stringify(adminResult, null, 2));
      return;
    }

    // Direct compose ps
    const state = await ensureStagedState();
    await runDockerCompose([...fullComposeArgs(state), 'ps', '--format', 'table']);
  },
});

export default defineCommand({
  meta: {
    name: 'service',
    description: 'Service lifecycle operations (start|stop|restart|logs|update|status)',
  },
  subCommands: {
    start: startCmd,
    stop: stopCmd,
    restart: restartCmd,
    logs: logsCmd,
    update: updateCmd,
    status: statusCmd,
  },
});
