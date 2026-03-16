import { defineCommand } from 'citty';
import { composeProjectArgs } from '../lib/docker.ts';

export async function runLogsAction(services: string[]): Promise<void> {
  const composeArgs = [
    'compose',
    ...composeProjectArgs(),
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

export default defineCommand({
  meta: {
    name: 'logs',
    description: 'Tail last 100 log lines for services',
  },
  args: {
    services: {
      type: 'positional',
      description: 'Service names (omit for all)',
      required: false,
    },
  },
  async run({ args }) {
    await runLogsAction(args._ ?? []);
  },
});
