import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';

vi.mock('@openpalm/lib', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openpalm/lib')>();
  return {
    ...original,
    getAkmStats: vi.fn(),
  };
});

import { GET, _resetStatsCacheForTests } from './+server.js';
import { getAkmStats } from '@openpalm/lib';

type StatsRequestEvent = Parameters<typeof GET>[0];

let rootDir = '';
let originalHome: string | undefined;

function makeEvent(token = 'admin-token'): StatsRequestEvent {
  const url = new URL('http://localhost/api/host/akm/stats');
  return {
    request: new Request(url, {
      method: 'GET',
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'x-request-id': 'req-akm-stats',
      },
    }),
    url,
    params: {},
  } as unknown as StatsRequestEvent;
}

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
  rootDir = join(tmpdir(), `openpalm-akm-stats-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
  vi.clearAllMocks();
  _resetStatsCacheForTests();
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('GET /api/host/akm/stats', () => {
  test('401 without auth', async () => {
    expect((await GET(makeEvent(''))).status).toBe(401);
  });

  test('returns read-only knowledge stats from akm json output', async () => {
    vi.mocked(getAkmStats).mockResolvedValue({
      available: true,
      version: '0.8.7',
      health: {
        status: 'warn',
        advisories: ['Semantic search needs attention.'],
      },
      boot: null,
      index: {
        entryCount: 42,
        lastBuiltAt: '2026-06-10T12:00:00.000Z',
        hasEmbeddings: true,
        vecAvailable: true,
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
        consolidation: { promoted: 3, merged: 2, deleted: 1 },
      },
      proposals: {
        pending: 2,
        items: [
          { ref: 'knowledge:test', generator: 'improve', createdAt: '2026-06-10T00:00:00.000Z', status: 'pending' },
          { ref: 'skill:demo', generator: 'propose', createdAt: '2026-06-09T00:00:00.000Z', status: 'pending' },
        ],
      },
    });

    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    expect(getAkmStats).toHaveBeenCalledTimes(1);

    const body = await res.json() as Record<string, unknown>;
    expect(body.available).toBe(true);
    expect(body.version).toBe('0.8.7');
    expect(body.health).toMatchObject({ status: 'warn', advisories: ['Semantic search needs attention.'] });
    expect(body.index).toMatchObject({ entryCount: 42, hasEmbeddings: true, vecAvailable: true });
    expect(body.assetCounts).toMatchObject({ memory: 8, skill: 5, lesson: 2 });
    expect(body.improve).toMatchObject({ invoked: 7, completed: 5, skipped: 2, reflectOk: 4, reflectCooldown: 1 });
    expect(body.proposals).toMatchObject({ pending: 2 });
  });

  test('fails soft when akm stats are unavailable', async () => {
    vi.mocked(getAkmStats).mockResolvedValue({
      available: false,
      reason: 'The assistant AKM CLI is not available.',
    });

    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      available: false,
      reason: 'The assistant AKM CLI is not available.',
    });
  });

  test('returns a structured 500 on unexpected failures', async () => {
    vi.mocked(getAkmStats).mockRejectedValue(new Error('boom'));

    const res = await GET(makeEvent());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: 'akm_stats_failed',
      message: 'boom',
      requestId: 'req-akm-stats',
    });
  });

  test('concurrent requests share a single in-flight CLI call', async () => {
    let resolveStats!: (value: Awaited<ReturnType<typeof getAkmStats>>) => void;
    const statsPromise = new Promise<Awaited<ReturnType<typeof getAkmStats>>>((resolve) => {
      resolveStats = resolve;
    });
    vi.mocked(getAkmStats).mockReturnValue(statsPromise);

    // Fire two requests simultaneously before the CLI resolves.
    const [res1Promise, res2Promise] = [GET(makeEvent()), GET(makeEvent())];

    resolveStats({ available: false, reason: 'deduped' });
    const [res1, res2] = await Promise.all([res1Promise, res2Promise]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Despite two concurrent requests, getAkmStats should only be called once.
    expect(getAkmStats).toHaveBeenCalledTimes(1);
  });
});
