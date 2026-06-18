/**
 * Tests for the npm registry lookups (resolveLatestNpmVersion / listNpmVersions).
 *
 * Same fetch-mocking pattern as upgrade-path.test.ts: `globalThis.fetch` is
 * replaced per-test and restored in afterEach.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { resolveLatestNpmVersion, listNpmVersions } from './npm-registry.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function npmResponse(data: {
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
  'dist-tags'?: Record<string, string>;
}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveLatestNpmVersion', () => {
  test('returns the latest dist-tag version', async () => {
    globalThis.fetch = (async () =>
      npmResponse({
        'dist-tags': { latest: '0.12.5', next: '0.13.0-rc.1' },
        versions: { '0.12.5': {}, '0.13.0-rc.1': {} },
      })) as typeof fetch;

    const version = await resolveLatestNpmVersion('@openpalm/lib');
    expect(version).toBe('0.12.5');
  });

  test('returns the next dist-tag when allowPrerelease is true', async () => {
    globalThis.fetch = (async () =>
      npmResponse({
        'dist-tags': { latest: '0.12.5', next: '0.13.0-rc.1' },
        versions: { '0.12.5': {}, '0.13.0-rc.1': {} },
      })) as typeof fetch;

    const version = await resolveLatestNpmVersion('@openpalm/lib', { allowPrerelease: true });
    expect(version).toBe('0.13.0-rc.1');
  });

  test('returns the explicitly requested dist-tag', async () => {
    globalThis.fetch = (async () =>
      npmResponse({
        'dist-tags': { latest: '0.12.5', next: '0.13.0-rc.1' },
        versions: { '0.12.5': {}, '0.13.0-rc.1': {} },
      })) as typeof fetch;

    const version = await resolveLatestNpmVersion('@openpalm/lib', { distTag: 'next' });
    expect(version).toBe('0.13.0-rc.1');
  });

  test('returns null when the dist-tag is absent', async () => {
    globalThis.fetch = (async () =>
      npmResponse({
        versions: { '0.12.5': {} },
      })) as typeof fetch;

    const version = await resolveLatestNpmVersion('@openpalm/lib');
    expect(version).toBeNull();
  });

  test('returns null on 404 (package not yet published)', async () => {
    globalThis.fetch = (async () =>
      new Response('not found', { status: 404 })) as typeof fetch;

    const version = await resolveLatestNpmVersion('@openpalm/nonexistent');
    expect(version).toBeNull();
  });

  test('throws on non-404 error status', async () => {
    globalThis.fetch = (async () =>
      new Response('server error', { status: 500 })) as typeof fetch;

    await expect(resolveLatestNpmVersion('@openpalm/lib')).rejects.toThrow(
      /npm registry lookup failed/,
    );
  });
});

describe('listNpmVersions', () => {
  test('returns versions sorted newest-first by publish time', async () => {
    globalThis.fetch = (async () =>
      npmResponse({
        versions: { '0.12.5': {}, '0.12.4': {}, '0.12.3': {} },
        time: {
          '0.12.5': '2026-06-18T00:00:00Z',
          '0.12.4': '2026-06-17T00:00:00Z',
          '0.12.3': '2026-06-16T00:00:00Z',
        },
        'dist-tags': { latest: '0.12.5' },
      })) as typeof fetch;

    const versions = await listNpmVersions('@openpalm/ui');
    expect(versions.map((v) => v.version)).toEqual(['0.12.5', '0.12.4', '0.12.3']);
  });

  test('marks prerelease versions and maps dist-tags', async () => {
    globalThis.fetch = (async () =>
      npmResponse({
        versions: { '0.13.0-rc.1': {}, '0.12.5': {} },
        time: {
          '0.13.0-rc.1': '2026-06-18T00:00:00Z',
          '0.12.5': '2026-06-17T00:00:00Z',
        },
        'dist-tags': { next: '0.13.0-rc.1', latest: '0.12.5' },
      })) as typeof fetch;

    const versions = await listNpmVersions('@openpalm/ui');
    expect(versions[0]).toMatchObject({ version: '0.13.0-rc.1', prerelease: true, distTag: 'next' });
    expect(versions[1]).toMatchObject({ version: '0.12.5', prerelease: false, distTag: 'latest' });
  });

  test('respects max option', async () => {
    const vs = ['0.12.5', '0.12.4', '0.12.3', '0.12.2', '0.12.1'];
    globalThis.fetch = (async () =>
      npmResponse({
        versions: Object.fromEntries(vs.map((v) => [v, {}])),
        time: Object.fromEntries(vs.map((v, i) => [v, `2026-06-${18 - i}T00:00:00Z`])),
      })) as typeof fetch;

    const versions = await listNpmVersions('@openpalm/ui', { max: 3 });
    expect(versions).toHaveLength(3);
    expect(versions[0]!.version).toBe('0.12.5');
  });

  test('returns empty list on 404 (package not yet published)', async () => {
    globalThis.fetch = (async () =>
      new Response('not found', { status: 404 })) as typeof fetch;

    const versions = await listNpmVersions('@openpalm/nonexistent');
    expect(versions).toEqual([]);
  });

  test('throws on non-404 error status', async () => {
    globalThis.fetch = (async () =>
      new Response('server error', { status: 500 })) as typeof fetch;

    await expect(listNpmVersions('@openpalm/lib')).rejects.toThrow(
      /npm registry lookup failed/,
    );
  });
});
