import { describe, expect, mock, test } from 'bun:test';
import { getAkmStats, parseAkmStats } from './akm-stats.js';
import type { ControlPlaneState } from './types.js';

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
      reason: 'AKM stats unavailable on this host.',
    });
  });
});

describe('getAkmStats', () => {
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

    mock.module('./assistant-akm.js', () => ({ runAssistantAkmCommand: runAssistantAkmCommandMock }));
    const { getAkmStats: getStats } = await import(`./akm-stats.js?warn=${Math.random()}`);
    const result = await getStats(state);

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.health.status).toBe('warn');
      expect(result.index.entryCount).toBe(12);
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

    mock.module('./assistant-akm.js', () => ({ runAssistantAkmCommand: runAssistantAkmCommandMock }));
    const { getAkmStats: getStats } = await import(`./akm-stats.js?enoent=${Math.random()}`);
    await expect(getStats(state)).resolves.toEqual({
      available: false,
      reason: 'The assistant AKM CLI is not available.',
    });
  });
});
