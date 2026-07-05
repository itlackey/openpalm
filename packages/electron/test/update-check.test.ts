// Run via vitest (Node). Covers the prerelease opt-in update-check (#504):
// channel-aware candidate selection, canonical version comparison, and the
// per-mode cache that prevents a stale stable answer leaking after the user
// enables prereleases.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isNewerVersion,
  selectPrereleaseCandidate,
  checkForElectronUpdate,
  _resetUpdateCheckCacheForTests,
} from '../src/update-check.js';

describe('isNewerVersion', () => {
  it('compares via canonical semver (handles v-prefix, prereleases)', () => {
    expect(isNewerVersion('0.11.5', 'v0.12.0')).toBe(true);
    expect(isNewerVersion('v0.12.0', '0.11.5')).toBe(false);
    expect(isNewerVersion('0.12.0', '0.12.0')).toBe(false);
    // A prerelease is older than its stable, newer than the prior stable.
    expect(isNewerVersion('0.12.0-rc.1', '0.12.0')).toBe(true);
    expect(isNewerVersion('0.11.5', '0.12.0-rc.1')).toBe(true);
    expect(isNewerVersion('0.12.0', '0.12.0-rc.1')).toBe(false);
  });

  it('returns false for non-semver inputs', () => {
    expect(isNewerVersion('latest', '0.12.0')).toBe(false);
    expect(isNewerVersion('0.12.0', 'dev')).toBe(false);
  });
});

describe('selectPrereleaseCandidate', () => {
  const releases = [
    { tag_name: 'v0.12.0-rc.2', html_url: 'u-rc2', prerelease: true },
    { tag_name: 'v0.12.0-rc.1', html_url: 'u-rc1', prerelease: true },
    { tag_name: 'v0.11.5', html_url: 'u-stable', prerelease: false },
    { tag_name: 'draft', html_url: 'u-draft', draft: true },
    { tag_name: 'nightly', html_url: 'u-bad' },
  ];

  it('offers a stable user only newer STABLE releases (no rc down-channel)', () => {
    expect(selectPrereleaseCandidate('0.11.4', releases)).toEqual({
      tag: 'v0.11.5',
      url: 'u-stable',
      prerelease: false,
    });
  });

  it('offers a stable user nothing when already on the newest stable', () => {
    expect(selectPrereleaseCandidate('0.11.5', releases)).toBeNull();
  });

  it('offers an rc user the newest prerelease', () => {
    expect(selectPrereleaseCandidate('0.12.0-rc.1', releases)).toEqual({
      tag: 'v0.12.0-rc.2',
      url: 'u-rc2',
      prerelease: true,
    });
  });

  it('skips drafts and non-semver tags', () => {
    const only = [
      { tag_name: 'draft', draft: true },
      { tag_name: 'nightly' },
    ];
    expect(selectPrereleaseCandidate('0.11.0', only)).toBeNull();
  });
});

describe('checkForElectronUpdate', () => {
  beforeEach(() => {
    _resetUpdateCheckCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetUpdateCheckCacheForTests();
  });

  it('stable mode polls /releases/latest and never reports a prerelease', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/releases/latest');
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v0.11.6',
          html_url: 'u',
          assets: [{ name: 'OpenPalm-0.11.6.AppImage' }],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const info = await checkForElectronUpdate('0.11.5', false);
    expect(info.updateAvailable).toBe(true);
    expect(info.latestVersion).toBe('0.11.6');
    expect(info.isPrerelease).toBe(false);
  });

  it('stable mode treats a release WITH a matching installer asset as updateAvailable', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/releases/latest');
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v0.11.6',
          html_url: 'u',
          assets: [{ name: 'OpenPalm-0.11.6.dmg' }, { name: 'openpalm-cli-linux' }],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const info = await checkForElectronUpdate('0.11.5', false);
    expect(info.updateAvailable).toBe(true);
    expect(info.latestVersion).toBe('0.11.6');
  });

  it('stable mode does NOT report an update for a bare release with NO installer assets', async () => {
    // A platform patch published with include_electron=false creates a newer
    // bare X.Y.Z release carrying only CLI/deploy assets — never an installer.
    // The desktop app must not advertise an update it cannot download (plan 3.3).
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/releases/latest');
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v0.11.6',
          html_url: 'u',
          assets: [{ name: 'openpalm-cli-linux' }, { name: 'deploy-bundle.tar.gz' }],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const info = await checkForElectronUpdate('0.11.5', false);
    expect(info.updateAvailable).toBe(false);
  });

  it('stable mode does NOT report an update when the release has no assets array at all', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/releases/latest');
      return {
        ok: true,
        json: async () => ({ tag_name: 'v0.11.6', html_url: 'u' }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const info = await checkForElectronUpdate('0.11.5', false);
    expect(info.updateAvailable).toBe(false);
  });

  it('prerelease mode polls the full list and surfaces a matching rc', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/releases?');
      return {
        ok: true,
        json: async () => [
          { tag_name: 'v0.12.0-rc.1', html_url: 'u-rc', prerelease: true },
          { tag_name: 'v0.11.5', html_url: 'u-stable', prerelease: false },
        ],
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const info = await checkForElectronUpdate('0.12.0-rc.0', true);
    expect(info.updateAvailable).toBe(true);
    expect(info.latestVersion).toBe('0.12.0-rc.1');
    expect(info.isPrerelease).toBe(true);
  });

  it('caches per-mode so enabling prereleases does not reuse the stable answer', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/releases/latest')) {
        return { ok: true, json: async () => ({ tag_name: 'v0.11.5' }) } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => [{ tag_name: 'v0.12.0-rc.1', html_url: 'u', prerelease: true }],
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const stable = await checkForElectronUpdate('0.11.5', false);
    expect(stable.updateAvailable).toBe(false);

    const pre = await checkForElectronUpdate('0.11.5', true);
    // A stable user opting in is offered nothing new here (rc is not newer than
    // their stable AND a stable user doesn't down-channel) — but the call MUST
    // have hit the full-list endpoint, not reused the stable cache.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pre.error).toBeUndefined();
  });
});
