import { defineCommand } from 'citty';
import { adminRequest } from '../lib/admin.ts';
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
    console.log(JSON.stringify(await adminRequest('/admin/containers/pull', { method: 'POST' }), null, 2));
  },
});

const statusCmd = defineCommand({
  meta: { name: 'status', description: 'Show container status' },
  async run() {
    console.log(JSON.stringify(await adminRequest('/admin/containers/list'), null, 2));
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
