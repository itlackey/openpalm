import { afterEach, describe, expect, mock, test } from 'bun:test';
import { computeLastRunsByTaskId, parseTaskHistoryRows } from './task-last-run.js';
import type { ControlPlaneState } from './types.js';
import * as realAssistantAkm from './assistant-akm.js';

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

describe('parseTaskHistoryRows', () => {
  test('decodes the { rows: [...] } envelope into the fields this feature needs', () => {
    const rows = parseTaskHistoryRows(
      JSON.stringify({
        shape: 'task-history',
        schemaVersion: 1,
        rows: [
          {
            id: 'nightly-digest',
            status: 'failed',
            startedAt: '2026-09-01T03:00:00.000Z',
            finishedAt: '2026-09-01T03:00:04.000Z',
            durationMs: 4000,
            log: '/data/akm/logs/nightly-digest/1.log',
            detail: { exitCode: 1 },
          },
        ],
      }),
    );

    expect(rows).toEqual([
      {
        id: 'nightly-digest',
        status: 'failed',
        startedAt: '2026-09-01T03:00:00.000Z',
        finishedAt: '2026-09-01T03:00:04.000Z',
        exitCode: 1,
      },
    ]);
  });

  test('drops rows missing id/status/startedAt instead of throwing', () => {
    expect(
      parseTaskHistoryRows(JSON.stringify({ rows: [{ status: 'completed', startedAt: '2026-09-01T00:00:00Z' }] })),
    ).toEqual([]);
  });

  test('returns no rows for unparseable or malformed json', () => {
    expect(parseTaskHistoryRows('not json')).toEqual([]);
    expect(parseTaskHistoryRows(JSON.stringify({ rows: 'nope' }))).toEqual([]);
    expect(parseTaskHistoryRows(JSON.stringify({}))).toEqual([]);
    expect(parseTaskHistoryRows('')).toEqual([]);
  });

  test('maps a missing/non-numeric detail.exitCode to null', () => {
    const rows = parseTaskHistoryRows(
      JSON.stringify({
        rows: [
          { id: 'a', status: 'active', startedAt: '2026-09-01T00:00:00Z', finishedAt: null },
        ],
      }),
    );
    expect(rows).toEqual([
      { id: 'a', status: 'active', startedAt: '2026-09-01T00:00:00Z', finishedAt: null, exitCode: null },
    ]);
  });
});

describe('computeLastRunsByTaskId', () => {
  test('keeps the newest row per task id regardless of input order', () => {
    const result = computeLastRunsByTaskId([
      { id: 'a', status: 'failed', startedAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T00:00:05Z', exitCode: 1 },
      { id: 'a', status: 'completed', startedAt: '2026-09-02T00:00:00Z', finishedAt: '2026-09-02T00:00:05Z', exitCode: 0 },
      { id: 'b', status: 'active', startedAt: '2026-09-01T12:00:00Z', finishedAt: null, exitCode: null },
    ]);

    expect(result).toEqual({
      a: { status: 'completed', at: '2026-09-02T00:00:05Z', exitCode: 0 },
      b: { status: 'active', at: '2026-09-01T12:00:00Z', exitCode: null },
    });
  });

  test('falls back to startedAt for `at` when finishedAt is absent (e.g. an active run)', () => {
    const result = computeLastRunsByTaskId([
      { id: 'a', status: 'active', startedAt: '2026-09-01T00:00:00Z', finishedAt: null, exitCode: null },
    ]);
    expect(result.a?.at).toBe('2026-09-01T00:00:00Z');
  });

  test('maps failed, completed, and active statuses through verbatim', () => {
    const result = computeLastRunsByTaskId([
      { id: 'failed-task', status: 'failed', startedAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T00:00:01Z', exitCode: 1 },
      { id: 'ok-task', status: 'completed', startedAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T00:00:01Z', exitCode: 0 },
      { id: 'running-task', status: 'active', startedAt: '2026-09-01T00:00:00Z', finishedAt: null, exitCode: null },
    ]);
    expect(result['failed-task']?.status).toBe('failed');
    expect(result['ok-task']?.status).toBe('completed');
    expect(result['running-task']?.status).toBe('active');
  });

  test('returns an empty object for empty input', () => {
    expect(computeLastRunsByTaskId([])).toEqual({});
  });
});

describe('fetchTaskHistoryLastRuns', () => {
  test('returns the reduced map on a successful call', async () => {
    const runAssistantAkmCommandMock = mock((_state: ControlPlaneState, args: string[]) => {
      expect(args).toEqual(['task', 'history', '--limit', '500', '--format', 'json', '--quiet']);
      return Promise.resolve({
        ok: true,
        stdout: JSON.stringify({
          rows: [
            { id: 'a', status: 'failed', startedAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T00:00:01Z', detail: { exitCode: 1 } },
          ],
        }),
        stderr: '',
        exitCode: 0,
        missing: false,
      });
    });
    mock.module('./assistant-akm.js', () => ({ runAssistantAkmCommand: runAssistantAkmCommandMock }));
    const { fetchTaskHistoryLastRuns: fetchLastRuns } = await import(`./task-last-run.js?ok=${Math.random()}`);

    expect(await fetchLastRuns(state)).toEqual({
      a: { status: 'failed', at: '2026-09-01T00:00:01Z', exitCode: 1 },
    });
  });

  test('is best-effort: a non-ok result yields {} rather than throwing', async () => {
    const runAssistantAkmCommandMock = mock(() =>
      Promise.resolve({ ok: false, stdout: '', stderr: 'boom', exitCode: 1, missing: false }),
    );
    mock.module('./assistant-akm.js', () => ({ runAssistantAkmCommand: runAssistantAkmCommandMock }));
    const { fetchTaskHistoryLastRuns: fetchLastRuns } = await import(`./task-last-run.js?notok=${Math.random()}`);

    expect(await fetchLastRuns(state)).toEqual({});
  });

  test('is best-effort: a missing akm CLI yields {} rather than throwing', async () => {
    const runAssistantAkmCommandMock = mock(() =>
      Promise.resolve({ ok: false, stdout: '', stderr: 'exec: "akm": executable file not found in $PATH', exitCode: 127, missing: true }),
    );
    mock.module('./assistant-akm.js', () => ({ runAssistantAkmCommand: runAssistantAkmCommandMock }));
    const { fetchTaskHistoryLastRuns: fetchLastRuns } = await import(`./task-last-run.js?missing=${Math.random()}`);

    expect(await fetchLastRuns(state)).toEqual({});
  });

  test('is best-effort: a thrown error yields {} rather than propagating', async () => {
    const runAssistantAkmCommandMock = mock(() => Promise.reject(new Error('docker exec exploded')));
    mock.module('./assistant-akm.js', () => ({ runAssistantAkmCommand: runAssistantAkmCommandMock }));
    const { fetchTaskHistoryLastRuns: fetchLastRuns } = await import(`./task-last-run.js?throw=${Math.random()}`);

    expect(await fetchLastRuns(state)).toEqual({});
  });
});
