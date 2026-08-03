import { describe, expect, mock, test } from 'bun:test';
import type { AssistantAkmCommandResult } from './assistant-akm.js';
import { AutomationRuntimeError } from './automation-runtime.js';
import type { AutomationTaskFileInfo } from './task-file-contract.js';
import { executeAutomation, getAutomationRegistrationStatus, readAutomationLogs } from './scheduler.js';
import type { ControlPlaneState } from './types.js';

const state = {} as ControlPlaneState;

function result(overrides: Partial<AssistantAkmCommandResult> = {}): AssistantAkmCommandResult {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
    missing: false,
    transportError: false,
    ...overrides,
  };
}

function task(fileName: string, taskId: string, schedulable = true): AutomationTaskFileInfo {
  return {
    fileName,
    taskId,
    schedulable,
    size: 1,
    revision: `sha256:${'0'.repeat(64)}`,
  };
}

function doctorResult(taskIds: string[]): AssistantAkmCommandResult {
  return result({
    stdout: JSON.stringify({
      shape: 'task-doctor',
      schemaVersion: 1,
      backend: 'cron',
      akm: { kind: 'npm', eligible: true },
      warnings: [],
      bindings: taskIds.length === 0 ? [] : [{ taskIds, status: ['ok'] }],
    }),
  });
}

function healthyTaskSync(): Promise<{ ok: true }> {
  return Promise.resolve({ ok: true });
}

describe('executeAutomation', () => {
  test('delegates a schedulable manual run to the Assistant AKM boundary', async () => {
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

  test('accepts the pinned AKM contract including an ID ending in a dot', async () => {
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
    await executeAutomation(state, 'foo..yml', run);
    expect(run).toHaveBeenCalledWith(state, ['task', 'run', 'foo.', '--format', 'json', '--quiet'], 0);
  });

  test('rejects unschedulable filenames before invoking AKM', async () => {
    const run = mock(() => Promise.resolve(result()));
    for (const fileName of ['.yml', '..yml', '...yml', 'foo .yml', 'nested.yml.yml']) {
      await expect(executeAutomation(state, fileName, run)).rejects.toThrow(
        'Invalid schedulable task file name',
      );
    }
    expect(run).not.toHaveBeenCalled();
  });

  test('throws unavailable when failed AKM stderr is not its JSON contract', async () => {
    const run = mock(() => Promise.resolve(result({ ok: false, stderr: 'task failed', exitCode: 1 })));
    await expect(executeAutomation(state, 'daily.yml', run)).rejects.toEqual(
      new AutomationRuntimeError('unavailable', 'Assistant automation execution is unavailable'),
    );
  });

  test('throws unavailable when AKM is missing or the command transport rejects', async () => {
    const missing = mock(() =>
      Promise.resolve(result({ ok: false, stderr: '/usr/local/bin/akm: not found', exitCode: 127, missing: true })),
    );
    await expect(executeAutomation(state, 'daily.yml', missing)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'AKM is unavailable in the Assistant',
    });

    const rejected = mock(() => Promise.reject(new Error('compose unavailable')));
    await expect(executeAutomation(state, 'daily.yml', rejected)).rejects.toEqual(
      new AutomationRuntimeError('unavailable', 'Assistant automation execution is unavailable'),
    );

    const timedOut = mock(() =>
      Promise.resolve(result({ ok: false, exitCode: 124, transportError: true })),
    );
    await expect(executeAutomation(state, 'daily.yml', timedOut)).rejects.toEqual(
      new AutomationRuntimeError('unavailable', 'Assistant automation execution is unavailable'),
    );
  });

  test('classifies AKM stderr JSON usage and missing-task errors', async () => {
    const usage = mock(() =>
      Promise.resolve(
        result({
          ok: false,
          stderr: JSON.stringify({
            ok: false,
            error: 'Task "daily" is missing a schedule.',
            code: 'MISSING_REQUIRED_ARGUMENT',
            hint: 'Fix the task file.',
          }),
          exitCode: 2,
        }),
      ),
    );
    await expect(executeAutomation(state, 'daily.yml', usage)).rejects.toEqual(
      new AutomationRuntimeError('invalid_request', 'Task "daily" is missing a schedule.'),
    );

    const codeLessUsage = mock(() =>
      Promise.resolve(
        result({
          ok: false,
          stderr: JSON.stringify({ ok: false, error: 'Invalid task definition.' }),
          exitCode: 2,
        }),
      ),
    );
    await expect(executeAutomation(state, 'daily.yml', codeLessUsage)).rejects.toEqual(
      new AutomationRuntimeError('invalid_request', 'Invalid task definition.'),
    );

    const missingTask = mock(() =>
      Promise.resolve(
        result({
          ok: false,
          stderr: JSON.stringify({
            ok: false,
            error: 'Stash asset not found for ref: tasks/daily',
            code: 'ASSET_NOT_FOUND',
          }),
          exitCode: 1,
        }),
      ),
    );
    await expect(executeAutomation(state, 'daily.yml', missingTask)).rejects.toEqual(
      new AutomationRuntimeError('not_found', 'Stash asset not found for ref: tasks/daily'),
    );

    const config = mock(() =>
      Promise.resolve(
        result({
          ok: false,
          stderr: JSON.stringify({ ok: false, error: 'Invalid AKM configuration.' }),
          exitCode: 78,
        }),
      ),
    );
    await expect(executeAutomation(state, 'daily.yml', config)).rejects.toEqual(
      new AutomationRuntimeError('invalid_request', 'Invalid AKM configuration.'),
    );

    const schema = mock(() =>
      Promise.resolve(
        result({
          ok: false,
          stderr: JSON.stringify({
            ok: false,
            error: 'Task schema version is unsupported.',
            code: 'TASK_SCHEMA_VERSION_UNSUPPORTED',
          }),
          exitCode: 1,
        }),
      ),
    );
    await expect(executeAutomation(state, 'daily.yml', schema)).rejects.toEqual(
      new AutomationRuntimeError('invalid_request', 'Task schema version is unsupported.'),
    );
  });

  test('does not expose malformed or internal AKM diagnostics', async () => {
    for (const [stderr, expected] of [
      [
        'database exception: /private/path',
        new AutomationRuntimeError('unavailable', 'Assistant automation execution is unavailable'),
      ],
      [
        JSON.stringify({ ok: false, error: 'secret internal exception', code: 'UNCAUGHT_EXCEPTION' }),
        new AutomationRuntimeError('invalid_response', 'AKM returned an invalid error response'),
      ],
    ] as const) {
      const run = mock(() =>
        Promise.resolve(result({ ok: false, stderr, exitCode: 70 })),
      );
      await expect(executeAutomation(state, 'daily.yml', run)).rejects.toEqual(expected);
    }
  });

  test('throws invalid_response for absent or malformed successful command envelopes', async () => {
    for (const stdout of ['', 'not json', '{}']) {
      const run = mock(() => Promise.resolve(result({ stdout })));
      await expect(executeAutomation(state, 'daily.yml', run)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
  });

  test('throws invalid_response for malformed output from a failed AKM command', async () => {
    const run = mock(() =>
      Promise.resolve(result({ ok: false, stdout: '{"shape":"wrong"}', exitCode: 1 })),
    );
    await expect(executeAutomation(state, 'daily.yml', run)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  test('preserves semantic failed and blocked envelopes as task results', async () => {
    for (const [status, detail, error] of [
      ['failed', { error: 'command failed' }, 'command failed'],
      ['blocked', { reason: 'dependency unavailable' }, 'dependency unavailable'],
    ] as const) {
      const run = mock(() =>
        Promise.resolve(
          result({
            ok: false,
            stdout: JSON.stringify({
              shape: 'task-run',
              schemaVersion: 1,
              ok: false,
              result: { status, detail },
              exitCode: 1,
            }),
            exitCode: 1,
          }),
        ),
      );
      await expect(executeAutomation(state, 'daily.yml', run)).resolves.toEqual({
        ok: false,
        status,
        error,
      });
    }
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
    await expect(executeAutomation(state, 'workflow.yml', run)).resolves.toEqual({
      ok: false,
      status: 'active',
    });
  });
});

describe('getAutomationRegistrationStatus', () => {
  test('combines container-listed files with scheduler IDs without claiming attribution', async () => {
    const list = mock(() =>
      Promise.resolve([
        task('daily.yml', 'daily'),
        task('missing.yml', 'missing'),
        task('foo .yml', 'foo ', false),
      ]),
    );
    const run = mock(() => Promise.resolve(doctorResult(['daily', 'other-bundle'])));

    const health = mock(healthyTaskSync);
    await expect(getAutomationRegistrationStatus(state, run, list, health)).resolves.toEqual({
      ok: true,
      localFileNames: ['daily.yml', 'missing.yml', 'foo .yml'],
      matchingSchedulerIds: ['daily'],
      localOnlyFileNames: ['missing.yml', 'foo .yml'],
      schedulerOnlyTaskIds: ['other-bundle'],
      attribution: 'unavailable',
    });
    expect(list).toHaveBeenCalledWith(state);
    expect(health).toHaveBeenCalledWith(state);
    expect(run).toHaveBeenCalledWith(state, ['task', 'doctor', '--format', 'json', '--quiet'], 10_000);
  });

  test('reports an Assistant task-list failure', async () => {
    const list = mock(() => Promise.reject(new Error('assistant is not running')));
    const run = mock(() => Promise.resolve(doctorResult([])));
    await expect(getAutomationRegistrationStatus(state, run, list, healthyTaskSync)).resolves.toEqual({
      ok: false,
      localFileNames: [],
      error: 'Unable to inspect task files: assistant is not running',
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('reports doctor failures after retaining the container-listed filenames', async () => {
    const list = mock(() => Promise.resolve([task('daily.yml', 'daily')]));
    const run = mock(() =>
      Promise.resolve(result({ ok: false, stderr: 'doctor unavailable', exitCode: 1 })),
    );
    await expect(getAutomationRegistrationStatus(state, run, list, healthyTaskSync)).resolves.toEqual({
      ok: false,
      localFileNames: ['daily.yml'],
      error: 'doctor unavailable',
    });
  });

  test('fails closed on stale reconciliation health without consulting AKM doctor', async () => {
    const list = mock(() => Promise.resolve([task('daily.yml', 'daily')]));
    const run = mock(() => Promise.resolve(doctorResult(['daily'])));
    const health = mock(() => Promise.resolve({ ok: false as const, error: 'status is stale' }));

    await expect(getAutomationRegistrationStatus(state, run, list, health)).resolves.toEqual({
      ok: false,
      localFileNames: ['daily.yml'],
      error: 'Task reconciliation health check failed: status is stale',
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('normalizes duplicate scheduler IDs', async () => {
    const list = mock(() => Promise.resolve([task('daily.yml', 'daily')]));
    const run = mock(() =>
      Promise.resolve(
        result({
          stdout: JSON.stringify({
            shape: 'task-doctor',
            schemaVersion: 1,
            backend: 'cron',
            akm: { kind: 'npm', eligible: true },
            warnings: [],
            bindings: [
              { taskIds: ['daily', 'daily', 'other-bundle'], status: ['ok'] },
              { taskIds: ['other-bundle'], status: ['ok'] },
            ],
          }),
        }),
      ),
    );
    await expect(getAutomationRegistrationStatus(state, run, list, healthyTaskSync)).resolves.toMatchObject({
      matchingSchedulerIds: ['daily'],
      schedulerOnlyTaskIds: ['other-bundle'],
    });
  });

  test('fails closed on malformed or unhealthy doctor output', async () => {
    const list = mock(() => Promise.resolve([]));
    const malformed = mock(() => Promise.resolve(result({ stdout: '{}' })));
    const malformedStatus = await getAutomationRegistrationStatus(
      state,
      malformed,
      list,
      healthyTaskSync,
    );
    expect(malformedStatus.ok).toBe(false);
    if (!malformedStatus.ok) expect(malformedStatus.error).toContain('unsupported response envelope');

    const unhealthy = mock(() =>
      Promise.resolve(
        result({
          stdout: JSON.stringify({
            shape: 'task-doctor',
            schemaVersion: 1,
            backend: 'cron',
            akm: { kind: 'npm', eligible: true },
            warnings: [],
            remediation: 'akm task sync --rebind',
            bindings: [],
          }),
        }),
      ),
    );
    const unhealthyStatus = await getAutomationRegistrationStatus(
      state,
      unhealthy,
      list,
      healthyTaskSync,
    );
    expect(unhealthyStatus.ok).toBe(false);
    if (!unhealthyStatus.ok) expect(unhealthyStatus.error).toContain('remediation');
  });
});

describe('readAutomationLogs', () => {
  test('delegates to the container runtime helper', async () => {
    const read = mock(() => Promise.resolve(['newest', 'older']));
    await expect(readAutomationLogs(state, 'daily.yml', 10, read)).resolves.toEqual([
      'newest',
      'older',
    ]);
    expect(read).toHaveBeenCalledWith(state, 'daily.yml', 10);
  });

  test('rejects unschedulable IDs before invoking the helper', async () => {
    const read = mock(() => Promise.resolve([]));
    for (const fileName of ['.yml', 'foo .yml', 'nested.yml.yml']) {
      await expect(readAutomationLogs(state, fileName, 10, read)).rejects.toThrow(
        'Invalid schedulable task file name',
      );
    }
    expect(read).not.toHaveBeenCalled();
  });
});
