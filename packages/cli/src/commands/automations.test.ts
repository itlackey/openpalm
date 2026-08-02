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
      configured: ['daily-digest', 'health-check'],
      registered: ['daily-digest'],
      missing: ['health-check'],
    });

    expect(logs).toContain('Registered in Assistant scheduler: 1/2');
    expect(logs).toContain('Not registered: health-check');
  });

  test('reports an Assistant inspection failure without reading the host crontab', async () => {
    await expect(
      automationsCheck({
        getState: () => state,
        inspect: mock(() =>
          Promise.resolve({ ok: false, configured: ['daily-digest'], error: 'assistant is not running' }),
        ),
      }),
    ).rejects.toThrow('Unable to inspect the Assistant scheduler: assistant is not running');
  });

  test('does not mask a task-file inspection failure as an empty install', async () => {
    await expect(
      automationsCheck({
        getState: () => state,
        inspect: mock(() => Promise.resolve({ ok: false, configured: [], error: 'unsafe tasks directory' })),
      }),
    ).rejects.toThrow('Unable to inspect the Assistant scheduler: unsafe tasks directory');
  });

  test('returns early when no v2 task files exist', async () => {
    const logs = await captureLogs({ ok: true, configured: [], registered: [], missing: [] });
    expect(logs).toEqual(['No automation tasks installed.']);
  });
});
