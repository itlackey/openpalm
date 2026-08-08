import { defineCommand } from 'citty';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveOpenPalmHome } from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';

export async function automationsCheck(): Promise<void> {
  const home = resolveOpenPalmHome();
  const tasksDir = join(home, 'knowledge', 'tasks');

  if (!existsSync(tasksDir)) {
    console.log('No tasks directory found at', tasksDir);
    process.exit(0);
  }

  const taskFiles = readdirSync(tasksDir).filter((f) => f.endsWith('.yml'));
  if (taskFiles.length === 0) {
    console.log('No automation tasks installed.');
    process.exit(0);
  }

  console.log(`Found ${taskFiles.length} automation task(s):`);
  for (const file of taskFiles) {
    console.log(`  - ${file.replace('.yml', '')}`);
  }

  // B5: `crontab` doesn't exist on Windows — execFile would ENOENT and print
  // the misleading "No crontab found — assistant not started?" message.
  // Guard on the platform instead, before the execFile shell-out.
  if (process.platform === 'win32') {
    console.log('Automation task registration check is not available on Windows (no crontab).');
    return;
  }

  // Check crontab for registered tasks
  await new Promise<void>((resolve) => {
    execFile('crontab', ['-l'], (error, stdout) => {
      if (error) {
        console.log('No crontab found — tasks not yet registered (assistant not started?)');
        resolve();
        return;
      }
      const registered = taskFiles.filter((f) => stdout.includes(f.replace('.yml', '')));
      console.log(`Registered in crontab: ${registered.length}/${taskFiles.length}`);
      if (registered.length < taskFiles.length) {
        console.log(
          "Run 'akm task sync' inside the assistant container to register remaining tasks."
        );
      }
      resolve();
    });
  });
}

export default defineCommand({
  meta: {
    name: 'automations',
    description: 'Manage automation tasks',
  },
  subCommands: {
    check: defineCommand({
      meta: {
        name: 'check',
        description: 'Report automation task registration status',
      },
      run: defineAction(async () => {
        await automationsCheck();
      }),
    }),
  },
});
