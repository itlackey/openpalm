import { afterEach, describe, expect, mock, test } from 'bun:test';
import { parseAkmStats } from './akm-stats.js';
import type { ControlPlaneState } from './types.js';
import * as realAssistantAkm from './assistant-akm.js';

// bun's mock.restore() does NOT undo mock.module(), so the module mocked below would
// otherwise leak into every other test file in the shared `bun test` process. Re-point
// it back to the real implementation after each test.
afterEach(() => {
  mock.restore();
  mock.module('./assistant-akm.js', () => ({ ...realAssistantAkm }));
});

const state: ControlPlaneState = {
  homeDir: '/tmp/openpalm',
  configDir: '/tmp/openpalm/config',
  stashDir: '/tmp/openpalm/knowledge',
  workspaceDir: '/tmp/openpalm/workspace',
  dataDir: '/tmp/openpalm/data',
  stackDir: '/tmp/openpalm/config/stack',
  services: {},
  artifacts: { compose: '' },
  artifactMeta: [],
};

describe('parseAkmStats', () => {
  test('projects health, info, and proposal json into a stable client shape', () => {
    const stats = parseAkmStats(
      JSON.stringify({
        status: 'warn',
        advisories: [
          { message: 'Semantic search needs attention.' },
          { name: 'proposal backlog' },
        ],
        improve: {
          invoked: 7,
          completed: 5,
          skipped: 2,
          reflect: { ok: 4, cooldown: 1 },
          consolidation: { promoted: 3, merged: 2, deleted: 1 },
        },
      }),
      JSON.stringify({
        version: '0.8.7',
        indexStats: {
          entryCount: 42,
          lastBuiltAt: '2026-06-10T12:00:00.000Z',
          hasEmbeddings: true,
          vecAvailable: false,
        },
        assetCounts: { memory: 8, skill: 5, lesson: 2 },
      }),
      JSON.stringify({
        proposals: [
          { ref: 'knowledge:test', generator: 'improve', createdAt: '2026-06-10T00:00:00.000Z', status: 'pending' },
        ],
      }),
    );

    expect(stats).toEqual({
      available: true,
      version: '0.8.7',
      health: {
        status: 'warn',
        advisories: ['Semantic search needs attention.', 'proposal backlog'],
      },
      boot: null,
      scheduler: null,
      index: {
        entryCount: 42,
        lastBuiltAt: '2026-06-10T12:00:00.000Z',
        hasEmbeddings: true,
        vecAvailable: false,
      },
      assetCounts: {
        memory: 8,
        skill: 5,
        lesson: 2,
      },
      improve: {
        invoked: 7,
        completed: 5,
        skipped: 2,
        reflectOk: 4,
        reflectCooldown: 1,
        consolidation: {
          promoted: 3,
          merged: 2,
          deleted: 1,
        },
      },
      proposals: {
        pending: 1,
        items: [
          {
            ref: 'knowledge:test',
            generator: 'improve',
            createdAt: '2026-06-10T00:00:00.000Z',
            status: 'pending',
          },
        ],
      },
    });
  });

  test('returns unavailable when both primary payloads are missing', () => {
    expect(parseAkmStats('', '', '')).toEqual({
      available: false,
      boot: null,
      reason: 'AKM stats unavailable on this host.',
    });
  });
});

describe('scheduler (task-fail-rate advisory, #677)', () => {
  test('surfaces a warn check, including the named worst offender', () => {
    const stats = parseAkmStats(
      JSON.stringify({
        status: 'warn',
        advisories: [
          {
            name: 'task-fail-rate',
            status: 'warn',
            message:
              'Cron task fail rate warning: task "nightly-digest" fails 100.0% of its 45 run(s) ≥ 5% — inspect failed runs (ok=false) for early-exit/harness errors.',
            evidence: {
              taskFailRate: 0.32,
              taskRowCount: 140,
              threshold: 0.05,
              worstTaskFailRate: { taskId: 'nightly-digest', rate: 1, rows: 45 },
            },
          },
        ],
        improve: {},
      }),
      JSON.stringify({ version: '0.9.9' }),
      JSON.stringify({ proposals: [] }),
    );

    expect(stats.available).toBe(true);
    if (!stats.available) throw new Error('expected available stats');
    expect(stats.scheduler).toEqual({
      degraded: true,
      taskFailRate: 0.32,
      taskRowCount: 140,
      worst: { taskId: 'nightly-digest', rate: 1, rows: 45 },
      message:
        'Cron task fail rate warning: task "nightly-digest" fails 100.0% of its 45 run(s) ≥ 5% — inspect failed runs (ok=false) for early-exit/harness errors.',
    });
  });

  test('surfaces a pass check with no worst offender', () => {
    const stats = parseAkmStats(
      JSON.stringify({
        status: 'pass',
        advisories: [
          {
            name: 'task-fail-rate',
            status: 'pass',
            message: 'Cron task fail rate 1.0% across 140 task(s) since 24h (below 5% threshold).',
            evidence: {
              taskFailRate: 0.01,
              taskRowCount: 140,
              threshold: 0.05,
              worstTaskFailRate: null,
            },
          },
        ],
        improve: {},
      }),
      JSON.stringify({ version: '0.9.9' }),
      JSON.stringify({ proposals: [] }),
    );

    expect(stats.available).toBe(true);
    if (!stats.available) throw new Error('expected available stats');
    expect(stats.scheduler).toEqual({
      degraded: false,
      taskFailRate: 0.01,
      taskRowCount: 140,
      worst: null,
      message: 'Cron task fail rate 1.0% across 140 task(s) since 24h (below 5% threshold).',
    });
  });

  test('is null when the check is absent from the report (older akm image)', () => {
    const stats = parseAkmStats(
      JSON.stringify({ status: 'pass', advisories: [], improve: {} }),
      JSON.stringify({ version: '0.8.7' }),
      JSON.stringify({ proposals: [] }),
    );

    expect(stats.available).toBe(true);
    if (!stats.available) throw new Error('expected available stats');
    expect(stats.scheduler).toBeNull();
  });
});

/** Marker contract: `<step> <exit> [detail words...]`, one line per boot step. */
function bootOf(marker: string | null) {
  const stats = parseAkmStats('{"status":"pass"}', '{}', '', marker);
  if (!stats.available) throw new Error('expected available stats');
  return stats.boot;
}

describe('boot marker', () => {
  test('keeps the boot record when akm itself cannot answer', () => {
    // The regression this guards: a boot so broken that `akm health`/`info`
    // return nothing is exactly when the marker matters most. Dropping it on
    // the unavailable path would hand the operator the same uninformative
    // string the marker exists to replace.
    const stats = parseAkmStats('', '', '', 'migrate 70 apply-failed\nhealth 0\n');
    expect(stats.available).toBe(false);
    expect(stats.boot).toEqual({
      degraded: true,
      steps: [
        { step: 'migrate', exit: 70, detail: 'apply-failed' },
        { step: 'health', exit: 0, detail: null },
      ],
    });
  });

  test('treats an empty marker as no data, not a clean boot', () => {
    expect(parseAkmStats('', '', '', '').boot).toBeNull();
    expect(parseAkmStats('', '', '', '\n  \n').boot).toBeNull();
  });

  test('parses a healthy boot as not degraded', () => {
    expect(bootOf('migrate 0 current\ntask-sync 0 installed=6\nhealth 4 warn\nsupercronic 0 running\n')).toEqual({
      degraded: false,
      steps: [
        { step: 'migrate', exit: 0, detail: 'current' },
        { step: 'task-sync', exit: 0, detail: 'installed=6' },
        { step: 'health', exit: 4, detail: 'warn' },
        { step: 'supercronic', exit: 0, detail: 'running' },
      ],
    });
  });

  test('reports degraded when a step exited non-zero', () => {
    expect(bootOf('migrate 70 apply failed\nhealth 0\n')).toEqual({
      degraded: true,
      steps: [
        { step: 'migrate', exit: 70, detail: 'apply failed' },
        { step: 'health', exit: 0, detail: null },
      ],
    });
  });

  test('treats health exit 4 as acceptable but any other non-zero health exit as degraded', () => {
    expect(bootOf('health 4 warn')?.degraded).toBe(false);
    expect(bootOf('health 1 fail')?.degraded).toBe(true);
  });

  test('returns null when the marker is absent or unreadable', () => {
    expect(bootOf(null)).toBeNull();
  });

  test('skips malformed lines instead of failing the parse', () => {
    expect(bootOf('\nmigrate\ntask-sync notanumber\nhealth 4.5\n  \nsupercronic 0 running\n')).toEqual({
      degraded: false,
      steps: [{ step: 'supercronic', exit: 0, detail: 'running' }],
    });
  });
});

describe('getAkmStats', () => {
  /** What `cat` reports when the assistant image predates the boot marker. */
  const absentBootMarker = () => Promise.resolve({
    ok: false,
    stdout: '',
    stderr: 'cat: /tmp/openpalm-akm-boot.status: No such file or directory',
    exitCode: 1,
    missing: true,
  });

  test('treats akm health exit code 4 as success and still parses stdout', async () => {
    const runAssistantAkmCommandMock = mock((
      _state: ControlPlaneState,
      args: string[],
      _timeoutMs: number,
      _options?: { allowExitCodes?: number[] },
    ) => {
      if (args[0] === 'health') {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify({ status: 'warn', advisories: [], improve: {} }),
          stderr: '',
          exitCode: 4,
          missing: false,
        });
      }
      if (args[0] === 'info') {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify({ version: '0.8.7', indexStats: { entryCount: 12 } }),
          stderr: '',
          exitCode: 0,
          missing: false,
        });
      }
      return Promise.resolve({
        ok: true,
        stdout: JSON.stringify({ proposals: [] }),
        stderr: '',
        exitCode: 0,
        missing: false,
      });
    });

    mock.module('./assistant-akm.js', () => ({
      runAssistantAkmCommand: runAssistantAkmCommandMock,
      runAssistantCommand: mock(absentBootMarker),
    }));
    const { getAkmStats: getStats } = await import(`./akm-stats.js?warn=${Math.random()}`);
    const result = await getStats(state);

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.health.status).toBe('warn');
      expect(result.index.entryCount).toBe(12);
      expect(result.boot).toBeNull();
    }
  });

  test('reads the boot marker from the assistant and reports it degraded', async () => {
    const runAssistantAkmCommandMock = mock(() => Promise.resolve({
      ok: true,
      stdout: JSON.stringify({ status: 'pass', advisories: [], improve: {} }),
      stderr: '',
      exitCode: 0,
      missing: false,
    }));
    const runAssistantCommandMock = mock(() => Promise.resolve({
      ok: true,
      stdout: 'migrate 70 apply failed\nsupercronic 0 running\n',
      stderr: '',
      exitCode: 0,
      missing: false,
    }));

    mock.module('./assistant-akm.js', () => ({
      runAssistantAkmCommand: runAssistantAkmCommandMock,
      runAssistantCommand: runAssistantCommandMock,
    }));
    const { getAkmStats: getStats } = await import(`./akm-stats.js?boot=${Math.random()}`);
    const result = await getStats(state);

    expect(runAssistantCommandMock).toHaveBeenCalledWith(
      state,
      ['cat', '/tmp/openpalm-akm-boot.status'],
      8_000,
    );
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.boot).toEqual({
        degraded: true,
        steps: [
          { step: 'migrate', exit: 70, detail: 'apply failed' },
          { step: 'supercronic', exit: 0, detail: 'running' },
        ],
      });
    }
  });

  test('fails soft when akm is missing from PATH', async () => {
    const runAssistantAkmCommandMock = mock(() => Promise.resolve({
      ok: false,
      stdout: '',
      stderr: 'exec: "akm": executable file not found in $PATH',
      exitCode: 127,
      missing: true,
    }));

    mock.module('./assistant-akm.js', () => ({
      runAssistantAkmCommand: runAssistantAkmCommandMock,
      runAssistantCommand: mock(absentBootMarker),
    }));
    const { getAkmStats: getStats } = await import(`./akm-stats.js?enoent=${Math.random()}`);
    await expect(getStats(state)).resolves.toEqual({
      available: false,
      boot: null,
      reason: 'The assistant AKM CLI is not available.',
    });
  });
});
