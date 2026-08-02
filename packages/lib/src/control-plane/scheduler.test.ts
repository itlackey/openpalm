import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantAkmCommandResult } from './assistant-akm.js';
import { executeAutomation, getAutomationRegistrationStatus } from './scheduler.js';
import type { ControlPlaneState } from './types.js';

let root: string;
let state: ControlPlaneState;

function result(overrides: Partial<AssistantAkmCommandResult> = {}): AssistantAkmCommandResult {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
    missing: false,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openpalm-scheduler-'));
  state = { stashDir: join(root, 'knowledge') } as ControlPlaneState;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('executeAutomation', () => {
  test('delegates a manual run to the Assistant AKM command boundary', async () => {
    const run = mock(() =>
      Promise.resolve(
        result({
          stdout: JSON.stringify({
            shape: 'task-run',
            schemaVersion: 1,
            ok: true,
            result: { status: 'completed' },
            exitCode: 0,
          }),
        }),
      ),
    );
    await expect(executeAutomation(state, 'daily.yml', run)).resolves.toEqual({
      ok: true,
      status: 'completed',
    });
    expect(run).toHaveBeenCalledWith(state, ['task', 'run', 'daily', '--format', 'json', '--quiet'], 0);
  });

  test('surfaces an in-container AKM failure', async () => {
    const run = mock(() => Promise.resolve(result({ ok: false, stderr: 'task failed', exitCode: 1 })));
    await expect(executeAutomation(state, 'daily', run)).resolves.toEqual({
      ok: false,
      status: 'failed',
      error: 'task failed',
    });
  });

  test('preserves an active workflow result instead of reporting completion', async () => {
    const run = mock(() =>
      Promise.resolve(
        result({
          stdout: JSON.stringify({
            shape: 'task-run',
            schemaVersion: 1,
            ok: false,
            result: { status: 'active', detail: { runId: 'run-1' } },
            exitCode: 0,
          }),
        }),
      ),
    );

    await expect(executeAutomation(state, 'workflow', run)).resolves.toEqual({
      ok: false,
      status: 'active',
    });
  });
});

describe('getAutomationRegistrationStatus', () => {
  test('compares .yml task files with Assistant task-doctor bindings', async () => {
    const tasksDir = join(state.stashDir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'daily.yml'), 'version: 2\n');
    writeFileSync(join(tasksDir, 'missing.yml'), 'version: 2\n');
    writeFileSync(join(tasksDir, 'legacy.yaml'), 'version: 2\n');
    const run = mock(() =>
      Promise.resolve(
        result({
          stdout: JSON.stringify({
            shape: 'task-doctor',
            schemaVersion: 1,
            backend: 'cron',
            akm: { kind: 'npm', eligible: true },
            warnings: [],
            bindings: [{ taskIds: ['daily', 'stale'], status: ['ok'] }],
          }),
        }),
      ),
    );

    await expect(getAutomationRegistrationStatus(state, run)).resolves.toEqual({
      ok: true,
      configured: ['daily', 'missing'],
      registered: ['daily'],
      missing: ['missing'],
    });
    expect(run).toHaveBeenCalledWith(state, ['task', 'doctor', '--format', 'json', '--quiet'], 10_000);
  });

  test('fails closed on malformed doctor output', async () => {
    const tasksDir = join(state.stashDir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'daily.yml'), 'version: 2\n');
    const run = mock(() => Promise.resolve(result({ stdout: '{}' })));

    const status = await getAutomationRegistrationStatus(state, run);
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error).toContain('unsupported response envelope');
  });

  test('fails closed on unhealthy doctor bindings', async () => {
    const tasksDir = join(state.stashDir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'daily.yml'), 'version: 2\n');
    const run = mock(() =>
      Promise.resolve(
        result({
          stdout: JSON.stringify({
            shape: 'task-doctor',
            schemaVersion: 1,
            backend: 'cron',
            akm: { kind: 'npm', eligible: true },
            warnings: [],
            remediation: 'akm task sync --rebind',
            bindings: [{ taskIds: ['daily'], status: ['checkout'] }],
          }),
        }),
      ),
    );

    const status = await getAutomationRegistrationStatus(state, run);
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error).toContain('remediation');
  });
});
