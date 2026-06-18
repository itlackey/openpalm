import { describe, expect, test } from 'vitest';
import { groupReleasesByUnit, selectInstallableReleases, type RawGitHubRelease } from './release-units.js';

function raw(tag: string, assets: string[] = [], prerelease = false): RawGitHubRelease {
  return {
    tag_name: tag,
    prerelease,
    published_at: '2026-06-18T00:00:00Z',
    assets: assets.map((name) => ({ name })),
  };
}

const ELECTRON_ASSET = 'OpenPalm-0.12.5.dmg';

describe('groupReleasesByUnit', () => {
  test('routes unit-prefixed tags to their unit lists with the prefix stripped', () => {
    const result = groupReleasesByUnit([
      raw('assistant-0.12.5'),
      raw('guardian-0.12.7'),
      raw('portals-0.12.6'),
    ]);

    expect(result.unitReleases.assistant.map((r) => r.tag)).toEqual(['0.12.5']);
    expect(result.unitReleases.guardian.map((r) => r.tag)).toEqual(['0.12.7']);
    expect(result.unitReleases.portals.map((r) => r.tag)).toEqual(['0.12.6']);
    // Unit releases never carry Electron assets.
    expect(result.unitReleases.guardian[0]!.hasElectronBuild).toBe(false);
    // Platform list stays empty when no platform/v tags are present.
    expect(result.releases).toEqual([]);
  });

  test('keeps platform-X.Y.Z and legacy vX.Y.Z under the platform list', () => {
    const result = groupReleasesByUnit([
      raw('platform-0.12.5', [ELECTRON_ASSET]),
      raw('v0.12.4'),
    ]);

    expect(result.releases.map((r) => r.tag)).toEqual(['0.12.5', '0.12.4']);
    expect(result.releases[0]!.hasElectronBuild).toBe(true);
    expect(result.releases[1]!.hasElectronBuild).toBe(false);
  });

  test('deduplicates platform-X.Y.Z vs legacy vX.Y.Z for the same semver', () => {
    // A platform release that created both tags must yield one entry, preferring
    // the platform-* tag (which carries the Electron asset).
    const result = groupReleasesByUnit([
      raw('platform-0.12.5', [ELECTRON_ASSET]),
      raw('v0.12.5'),
    ]);

    expect(result.releases.map((r) => r.tag)).toEqual(['0.12.5']);
    expect(result.releases[0]!.hasElectronBuild).toBe(true);
  });

  test('deduplicates within a unit list by semver', () => {
    const result = groupReleasesByUnit([
      raw('guardian-0.12.7'),
      raw('guardian-0.12.7'),
    ]);

    expect(result.unitReleases.guardian.map((r) => r.tag)).toEqual(['0.12.7']);
  });

  test('skips non-matching tags (e.g. out-of-band publish workflows)', () => {
    const result = groupReleasesByUnit([
      raw('publish-assistant-models-v1'),
      raw('latest'),
      raw('assistant-0.12.5'),
    ]);

    expect(result.unitReleases.assistant.map((r) => r.tag)).toEqual(['0.12.5']);
    expect(result.releases).toEqual([]);
  });

  test('handles pre-release unit tags', () => {
    const result = groupReleasesByUnit([
      raw('assistant-0.13.0-rc.1', [], true),
    ]);

    expect(result.unitReleases.assistant.map((r) => r.tag)).toEqual(['0.13.0-rc.1']);
    expect(result.unitReleases.assistant[0]!.prerelease).toBe(true);
  });

  test('returns empty lists for an empty input', () => {
    const result = groupReleasesByUnit([]);

    expect(result.releases).toEqual([]);
    expect(result.unitReleases).toEqual({ assistant: [], guardian: [], portals: [] });
  });
});

describe('selectInstallableReleases', () => {
  test('returns only platform releases with Electron installer assets', () => {
    const releases = selectInstallableReleases([
      raw('platform-0.12.5', [ELECTRON_ASSET]),
      raw('assistant-0.12.5'),
      raw('guardian-0.12.7'),
    ]);

    expect(releases.map((r) => r.tag)).toEqual(['0.12.5']);
    expect(releases[0]!.hasElectronBuild).toBe(true);
  });

  test('skips platform releases without Electron assets', () => {
    const releases = selectInstallableReleases([
      raw('platform-0.12.4'),
      raw('v0.12.3', [ELECTRON_ASSET]),
    ]);

    expect(releases.map((r) => r.tag)).toEqual(['0.12.3']);
  });

  test('deduplicates platform-* and legacy v* tags for the same semver', () => {
    const releases = selectInstallableReleases([
      raw('platform-0.12.5', [ELECTRON_ASSET]),
      raw('v0.12.5', [ELECTRON_ASSET]),
    ]);

    expect(releases).toHaveLength(1);
    expect(releases[0]!.tag).toBe('0.12.5');
  });

  test('skips per-unit tags (assistant-*, guardian-*, portals-*)', () => {
    const releases = selectInstallableReleases([
      raw('assistant-0.12.5', [ELECTRON_ASSET]),
      raw('guardian-0.12.7', [ELECTRON_ASSET]),
      raw('portals-0.12.6', [ELECTRON_ASSET]),
    ]);

    expect(releases).toEqual([]);
  });

  test('returns empty list for an empty input', () => {
    expect(selectInstallableReleases([])).toEqual([]);
  });
});
