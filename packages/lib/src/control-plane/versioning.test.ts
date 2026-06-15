import { describe, it, expect } from 'bun:test';
import {
  PLATFORM_VERSION,
  normalizeVersion,
  formatForDocker,
  formatForDisplay,
  isPrerelease,
  distTagForVersion,
  isComparableSemver,
  compareComparableVersions,
  majorVersionOf,
} from './versioning.js';
import libPkg from '../../package.json' with { type: 'json' };

describe('PLATFORM_VERSION', () => {
  it('is the v-prefixed lib package version (single source of truth)', () => {
    expect(PLATFORM_VERSION).toBe(`v${libPkg.version.replace(/^v/, '')}`);
    expect(PLATFORM_VERSION.startsWith('v')).toBe(true);
    expect(isComparableSemver(PLATFORM_VERSION)).toBe(true);
  });
});

describe('normalizeVersion', () => {
  it('strips a single leading v and trims', () => {
    expect(normalizeVersion('v0.12.0')).toBe('0.12.0');
    expect(normalizeVersion('0.12.0')).toBe('0.12.0');
    expect(normalizeVersion('  v1.2.3-rc.1 ')).toBe('1.2.3-rc.1');
  });
  it('handles empty / nullish', () => {
    expect(normalizeVersion('')).toBe('');
    expect(normalizeVersion(null)).toBe('');
    expect(normalizeVersion(undefined)).toBe('');
  });
});

describe('formatForDocker', () => {
  it('ensures exactly one leading v', () => {
    expect(formatForDocker('0.12.0')).toBe('v0.12.0');
    expect(formatForDocker('v0.12.0')).toBe('v0.12.0');
    expect(formatForDocker('0.12.0-rc.1')).toBe('v0.12.0-rc.1');
  });
  it('returns empty for empty input', () => {
    expect(formatForDocker('')).toBe('');
    expect(formatForDocker(null)).toBe('');
  });
});

describe('formatForDisplay', () => {
  it('drops the v for user-facing display', () => {
    expect(formatForDisplay('v0.12.0')).toBe('0.12.0');
    expect(formatForDisplay('0.12.0')).toBe('0.12.0');
  });
});

describe('isPrerelease', () => {
  it('detects semver pre-release segments', () => {
    expect(isPrerelease('0.12.0-rc.1')).toBe(true);
    expect(isPrerelease('v0.12.0-rc.1')).toBe(true);
    expect(isPrerelease('0.12.0')).toBe(false);
    expect(isPrerelease('v0.12.0')).toBe(false);
  });
  it('ignores build metadata and non-semver', () => {
    expect(isPrerelease('0.12.0+build.5')).toBe(false);
    expect(isPrerelease('latest')).toBe(false);
    expect(isPrerelease(null)).toBe(false);
  });
});

describe('distTagForVersion', () => {
  it('maps prerelease -> next and stable -> latest', () => {
    expect(distTagForVersion('0.12.0-rc.1')).toBe('next');
    expect(distTagForVersion('v0.12.0-rc.1')).toBe('next');
    expect(distTagForVersion('0.12.0')).toBe('latest');
    expect(distTagForVersion('latest')).toBe('latest');
  });
});

describe('comparison helpers still behave', () => {
  it('compares across v-prefix forms', () => {
    expect(compareComparableVersions('v0.12.0', '0.11.5')).toBe(1);
    expect(compareComparableVersions('0.12.0-rc.1', '0.12.0')).toBe(-1);
  });
  it('majorVersionOf parses both forms', () => {
    expect(majorVersionOf('v1.2.3')).toBe(1);
    expect(majorVersionOf('1.2.3')).toBe(1);
    expect(majorVersionOf('nope')).toBeNull();
  });
});
