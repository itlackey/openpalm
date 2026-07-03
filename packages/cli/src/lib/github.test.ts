import { describe, expect, it } from 'bun:test';
import { GITHUB_REPO, parseReleaseTagFromLocation } from './github.ts';

describe('GITHUB_REPO', () => {
  it('is the canonical OpenPalm slug', () => {
    expect(GITHUB_REPO).toBe('itlackey/openpalm');
  });
});

describe('parseReleaseTagFromLocation', () => {
  it('parses a bare semver tag from the redirect target', () => {
    expect(
      parseReleaseTagFromLocation('https://github.com/itlackey/openpalm/releases/tag/0.12.43'),
    ).toBe('0.12.43');
  });

  it('preserves a legacy v-prefixed tag', () => {
    expect(
      parseReleaseTagFromLocation('https://github.com/itlackey/openpalm/releases/tag/v0.11.0'),
    ).toBe('v0.11.0');
  });

  it('keeps prerelease suffixes', () => {
    expect(
      parseReleaseTagFromLocation('https://github.com/itlackey/openpalm/releases/tag/0.12.0-rc.1'),
    ).toBe('0.12.0-rc.1');
  });

  it('returns null for a missing or empty location', () => {
    expect(parseReleaseTagFromLocation(null)).toBeNull();
    expect(parseReleaseTagFromLocation(undefined)).toBeNull();
    expect(parseReleaseTagFromLocation('')).toBeNull();
  });

  it('returns null when the target is not a /tag/<semver> URL', () => {
    expect(parseReleaseTagFromLocation('https://github.com/itlackey/openpalm/releases')).toBeNull();
    expect(
      parseReleaseTagFromLocation('https://github.com/itlackey/openpalm/releases/tag/main'),
    ).toBeNull();
    expect(
      parseReleaseTagFromLocation('https://github.com/itlackey/openpalm/releases/tag/1.2'),
    ).toBeNull();
  });
});
