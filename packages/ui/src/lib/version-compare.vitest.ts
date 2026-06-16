import { describe, expect, test } from 'vitest';
import { compareVersions, isSemver, updateStatus, latestForChannel, formatVersionForDisplay, channelOf } from './version-compare.js';

describe('compareVersions', () => {
  test('orders patch/minor/major', () => {
    expect(compareVersions('0.11.3', '0.11.2')).toBe(1);
    expect(compareVersions('0.11.2', '0.11.3')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.11.3', '0.11.3')).toBe(0);
  });

  test('stable outranks a pre-release of the same number; rc.N ordered numerically', () => {
    expect(compareVersions('0.11.3', '0.11.3-rc.3')).toBe(1);
    expect(compareVersions('0.11.3-rc.3', '0.11.3-rc.2')).toBe(1);
    expect(compareVersions('0.11.3-rc.10', '0.11.3-rc.2')).toBe(1);
  });

  test('ignores a leading v', () => {
    expect(compareVersions('v0.11.3', '0.11.3')).toBe(0);
    expect(compareVersions('v0.11.3-rc.3', '0.11.3-rc.2')).toBe(1);
  });

  test('ignores build metadata per semver (no NaN corruption)', () => {
    expect(compareVersions('0.11.3+build.5', '0.11.3')).toBe(0);
    expect(compareVersions('0.11.4+build.1', '0.11.3')).toBe(1);
    expect(compareVersions('0.11.3-rc.2+sha.abc', '0.11.3-rc.1')).toBe(1);
  });
});

describe('isSemver', () => {
  test('accepts semver (optionally v-prefixed, with pre-release)', () => {
    expect(isSemver('0.11.3')).toBe(true);
    expect(isSemver('v0.11.3-rc.3')).toBe(true);
  });
  test('rejects moving tags / empties', () => {
    expect(isSemver('latest')).toBe(false);
    expect(isSemver('')).toBe(false);
    expect(isSemver(null)).toBe(false);
    expect(isSemver(undefined)).toBe(false);
  });
});

describe('updateStatus', () => {
  test('flags an available update and a current build', () => {
    // The exact rc.2-app / rc.3-latest case from the bug report.
    expect(updateStatus('0.11.3-rc.2', '0.11.3-rc.3')).toBe('update');
    expect(updateStatus('0.11.3-rc.3', '0.11.3-rc.3')).toBe('current');
    expect(updateStatus('v0.11.1', '0.11.3-rc.3')).toBe('update');
  });
  test('is unknown when either side is not comparable (e.g. a moving tag)', () => {
    expect(updateStatus('latest', '0.11.3-rc.3')).toBe('unknown');
    expect(updateStatus('0.11.3-rc.3', null)).toBe('unknown');
  });
});

describe('latestForChannel', () => {
  const releases = [
    { version: '0.11.3-rc.3', prerelease: true },
    { version: '0.11.2', prerelease: false },
    { version: '0.11.3-rc.2', prerelease: true },
    { version: '0.11.1', prerelease: false },
  ];

  test('a pre-release install sees the newest pre-release', () => {
    expect(latestForChannel('0.11.3-rc.2', releases)).toBe('0.11.3-rc.3');
  });

  test('a stable install only sees the newest STABLE release', () => {
    expect(latestForChannel('0.11.2', releases)).toBe('0.11.2');
  });

  test('returns null when no candidate qualifies', () => {
    expect(latestForChannel('0.11.2', [])).toBe(null);
  });
});

describe('formatVersionForDisplay (#503)', () => {
  test('drops a single leading v', () => {
    expect(formatVersionForDisplay('v0.12.0')).toBe('0.12.0');
    expect(formatVersionForDisplay('v0.12.0-rc.1')).toBe('0.12.0-rc.1');
  });
  test('passes through an already-bare version', () => {
    expect(formatVersionForDisplay('0.12.0')).toBe('0.12.0');
  });
  test('leaves a moving tag untouched and handles null/empty', () => {
    expect(formatVersionForDisplay('latest')).toBe('latest');
    expect(formatVersionForDisplay(null)).toBe('');
    expect(formatVersionForDisplay(undefined)).toBe('');
    expect(formatVersionForDisplay('  v0.12.0  ')).toBe('0.12.0');
  });
});

describe('channelOf (#503)', () => {
  test('stable for a plain release', () => {
    expect(channelOf('0.12.0')).toBe('stable');
    expect(channelOf('v0.11.5')).toBe('stable');
  });
  test('prerelease for an rc/beta', () => {
    expect(channelOf('0.12.0-rc.1')).toBe('prerelease');
    expect(channelOf('v0.12.0-beta.3')).toBe('prerelease');
  });
  test('unknown for a moving tag or no data', () => {
    expect(channelOf('latest')).toBe('unknown');
    expect(channelOf(null)).toBe('unknown');
    expect(channelOf('')).toBe('unknown');
  });
});
