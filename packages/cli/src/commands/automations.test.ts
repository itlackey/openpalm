import { describe, expect, mock, test } from 'bun:test';
import type { AutomationRegistrationStatus, ControlPlaneState } from '@openpalm/lib';
import { automationsCheck } from './automations.ts';

const state = {} as ControlPlaneState;

async function captureLogs(status: AutomationRegistrationStatus): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    await automationsCheck({
      getState: () => state,
      inspect: mock(() => Promise.resolve(status)),
    });
  } finally {
    console.log = originalLog;
  }
  return logs;
}

describe('automationsCheck', () => {
  test('reports registrations from the Assistant scheduler', async () => {
    const logs = await captureLogs({
      ok: true,
      localFileNames: ['daily-digest.yml', 'health-check.yml'],
      matchingSchedulerIds: ['daily-digest'],
      localOnlyFileNames: ['health-check.yml'],
      schedulerOnlyTaskIds: ['other-bundle'],
      attribution: 'unavailable',
    });

    expect(logs).toContain('Scheduler ID matches: 1/2 (bundle attribution unavailable)');
    expect(logs).toContain('Local files without a matching scheduler ID: "health-check.yml"');
    expect(logs).toContain('Scheduler-only IDs: "other-bundle"');
  });

  test('reports an Assistant inspection failure without reading the host crontab', async () => {
    await expect(
      automationsCheck({
        getState: () => state,
        inspect: mock(() =>
          Promise.resolve({
            ok: false,
            localFileNames: ['daily-digest.yml'],
            error: 'assistant is not running',
          }),
        ),
      }),
    ).rejects.toThrow('Unable to inspect the Assistant scheduler: assistant is not running');
  });

  test('does not mask a task-file inspection failure as an empty install', async () => {
    await expect(
      automationsCheck({
        getState: () => state,
        inspect: mock(() =>
          Promise.resolve({ ok: false, localFileNames: [], error: 'unsafe tasks directory' }),
        ),
      }),
    ).rejects.toThrow('Unable to inspect the Assistant scheduler: unsafe tasks directory');
  });

  test('reports scheduler-only bindings when no local task files exist', async () => {
    const logs = await captureLogs({
      ok: true,
      localFileNames: [],
      matchingSchedulerIds: [],
      localOnlyFileNames: [],
      schedulerOnlyTaskIds: ['other-bundle'],
      attribution: 'unavailable',
    });
    expect(logs).toEqual([
      'No local automation task files installed.',
      'Scheduler-only IDs: "other-bundle"',
    ]);
  });

  test('reports an empty local and scheduler state', async () => {
    const logs = await captureLogs({
      ok: true,
      localFileNames: [],
      matchingSchedulerIds: [],
      localOnlyFileNames: [],
      schedulerOnlyTaskIds: [],
      attribution: 'unavailable',
    });
    expect(logs).toEqual(['No local automation task files installed.']);
  });

  test('escapes terminal control characters in local filenames and scheduler IDs', async () => {
    const logs = await captureLogs({
      ok: true,
      localFileNames: ['line\nbreak.yml', 'color\u001b[31m.yml'],
      matchingSchedulerIds: [],
      localOnlyFileNames: ['line\nbreak.yml', 'color\u001b[31m.yml'],
      schedulerOnlyTaskIds: ['direction\u202eright'],
      attribution: 'unavailable',
    });

    expect(logs).toContain('  - "line\\u000abreak.yml"');
    expect(logs).toContain('  - "color\\u001b[31m.yml"');
    expect(logs).toContain('Scheduler-only IDs: "direction\\u202eright"');
    expect(logs.join('\n')).not.toContain('\u001b');
    expect(logs).toHaveLength(6);
  });
});
