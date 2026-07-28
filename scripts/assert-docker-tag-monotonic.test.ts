import { describe, expect, test } from 'bun:test';
import {
  assertDockerTagMonotonic,
  fetchDockerHubTags,
  highestDockerTagVersion,
  versionFromDockerTag,
} from './assert-docker-tag-monotonic.mjs';

describe('Docker tag monotonic guard', () => {
  test('compares strict semver and ignores aliases', () => {
    expect(highestDockerTagVersion(['latest', '0.13.0-beta.2', 'v0.12.9', 'bad'])).toBe('0.13.0-beta.2');
    expect(() => assertDockerTagMonotonic('0.13.0-beta.1', ['0.13.0-beta.2'])).toThrow(
      'must be greater',
    );
    expect(assertDockerTagMonotonic('0.13.0', ['0.13.0-beta.2'])).toBe('0.13.0-beta.2');
    expect(() => assertDockerTagMonotonic('1.2.3-$(id)', [])).toThrow('Invalid semver target');
  });

  test('compares Voice base versions independently for each variant', () => {
    const tags = ['latest-cpu', '0.12.0-cpu', '0.13.0-beta.2-cpu', '9.0.0-cu121'];
    expect(highestDockerTagVersion(tags, { suffix: 'cpu' })).toBe('0.13.0-beta.2');
    expect(versionFromDockerTag('0.13.0-beta.2-cpu', { suffix: 'cpu' })).toBe('0.13.0-beta.2');
    expect(assertDockerTagMonotonic('0.13.0', tags, { suffix: 'cpu' })).toBe('0.13.0-beta.2');
  });

  test('compares immutable model bundle vN tags numerically', () => {
    expect(highestDockerTagVersion(['latest', 'v2', 'v10'], { mode: 'model' })).toBe('v10');
    expect(() => assertDockerTagMonotonic('v3', ['v2', 'v10'], { mode: 'model' })).toThrow(
      'existing Docker version v10',
    );
    expect(assertDockerTagMonotonic('v11', ['v2', 'v10'], { mode: 'model' })).toBe('v10');
  });

  test('paginates Docker Hub tag responses', async () => {
    const calls: string[] = [];
    const tags = await fetchDockerHubTags('openpalm/assistant', async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => calls.length === 1
          ? { results: [{ name: '0.12.0' }], next: 'https://hub.docker.com/page-2' }
          : { results: [{ name: '0.13.0' }], next: null },
      } as Response;
    });
    expect(tags).toEqual(['0.12.0', '0.13.0']);
    expect(calls).toHaveLength(2);
  });
});
