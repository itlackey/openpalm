import { describe, expect, test } from 'vitest';
import { selectInstallableReleases, type RawGitHubRelease } from './release-units.js';

function raw(tag: string, assets: string[] = [], prerelease = false): RawGitHubRelease {
  return {
    tag_name: tag,
    prerelease,
    published_at: '2026-06-18T00:00:00Z',
    assets: assets.map((name) => ({ name })),
  };
}

const ELECTRON_ASSET = 'OpenPalm-0.12.5.dmg';

describe('selectInstallableReleases', () => {
  test('returns bare semver product releases with installer assets', () => {
    const releases = selectInstallableReleases([
      raw('0.13.0', [ELECTRON_ASSET]),
      raw('0.14.0-beta.2', [ELECTRON_ASSET], true),
    ]);

    expect(releases.map((r) => r.tag)).toEqual(['0.13.0', '0.14.0-beta.2']);
    expect(releases[1]?.prerelease).toBe(true);
  });

  test('returns only platform releases with Electron installer assets', () => {
    const releases = selectInstallableReleases([
      raw('platform-0.12.5', [ELECTRON_ASSET]),
      raw('assistant-0.12.5'),
      raw('guardian-0.12.7'),
    ]);

    expect(releases.map((r) => r.tag)).toEqual(['0.12.5']);
    expect(releases[0]?.hasElectronBuild).toBe(true);
  });

  test('returns standalone electron-* releases with installer assets', () => {
    const releases = selectInstallableReleases([
      raw('electron-0.12.6', [ELECTRON_ASSET]),
      raw('guardian-0.12.7', [ELECTRON_ASSET]),
    ]);

    expect(releases.map((r) => r.tag)).toEqual(['0.12.6']);
    expect(releases[0]?.hasElectronBuild).toBe(true);
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
    expect(releases[0]?.tag).toBe('0.12.5');
  });

  test('deduplicates platform-* and electron-* tags for coordinated releases', () => {
    const releases = selectInstallableReleases([
      raw('platform-0.12.5', [ELECTRON_ASSET]),
      raw('electron-0.12.5', [ELECTRON_ASSET]),
    ]);

    expect(releases).toHaveLength(1);
    expect(releases[0]?.tag).toBe('0.12.5');
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
