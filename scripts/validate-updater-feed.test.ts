// Release gate for the desktop updater feed (#572). A release that ships
// latest.yml but not the installer it names breaks updates for every installed
// desktop app, so these cases pin the failure modes that gate must catch.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  feedChannelForVersion,
  forbiddenFeedsFor,
  parseUpdaterFeed,
  updaterFeedsFor,
  validateFeed,
  validateUpdaterFeeds,
} from './validate-updater-feed.mjs';
import { expectedDesktopAssets } from './validate-release-assets.mjs';

function feedYaml(version: string, file: string): string {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${file}`,
    '    sha512: Zm9vYmFy',
    '    size: 12345',
    `path: ${file}`,
    'sha512: Zm9vYmFy',
    `releaseDate: '2026-07-30T00:00:00.000Z'`,
    '',
  ].join('\n');
}

describe('parseUpdaterFeed', () => {
  test('reads version, path, sha512 and the files list', () => {
    const feed = parseUpdaterFeed(feedYaml('1.2.3', 'OpenPalm-1.2.3.exe'));
    expect(feed.version).toBe('1.2.3');
    expect(feed.path).toBe('OpenPalm-1.2.3.exe');
    expect(feed.sha512).toBe('Zm9vYmFy');
    expect(feed.files).toEqual([
      { url: 'OpenPalm-1.2.3.exe', sha512: 'Zm9vYmFy', size: '12345' },
    ]);
  });

  test('strips quotes that electron-builder adds around some versions', () => {
    expect(parseUpdaterFeed("version: '1.2.3-beta.1'\n").version).toBe('1.2.3-beta.1');
  });
});

describe('validateFeed', () => {
  const present = new Set(['OpenPalm-1.2.3.exe', 'latest.yml']);

  test('accepts a feed whose version matches and whose asset is present', () => {
    const problems = validateFeed(
      'latest.yml', feedYaml('1.2.3', 'OpenPalm-1.2.3.exe'), '1.2.3', present,
    );
    expect(problems).toEqual([]);
  });

  test('rejects a feed advertising a different version than the release', () => {
    const problems = validateFeed(
      'latest.yml', feedYaml('1.2.2', 'OpenPalm-1.2.3.exe'), '1.2.3', present,
    );
    expect(problems.join(' ')).toMatch(/does not match release 1\.2\.3/);
  });

  test('rejects a feed referencing an installer that is not being uploaded', () => {
    const problems = validateFeed(
      'latest.yml', feedYaml('1.2.3', 'OpenPalm-1.2.3-missing.exe'), '1.2.3', present,
    );
    expect(problems.join(' ')).toMatch(/references missing asset/);
  });

  test('rejects an entry with no sha512 — corruption would go undetected', () => {
    const yaml = ['version: 1.2.3', 'files:', '  - url: OpenPalm-1.2.3.exe', '    size: 1', ''].join('\n');
    const problems = validateFeed('latest.yml', yaml, '1.2.3', present);
    expect(problems.join(' ')).toMatch(/has no sha512/);
  });

  test('rejects a feed that references no installer at all', () => {
    const problems = validateFeed('latest.yml', 'version: 1.2.3\n', '1.2.3', present);
    expect(problems.join(' ')).toMatch(/references no installer/);
  });
});

describe('validateUpdaterFeeds', () => {
  function withDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'updater-feed-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('passes when both updater-capable feeds are complete', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'latest.yml'), feedYaml('1.2.3', 'OpenPalm-1.2.3.exe'));
      writeFileSync(join(dir, 'latest-linux.yml'), feedYaml('1.2.3', 'OpenPalm-1.2.3.AppImage'));
      const present = new Set([
        'latest.yml', 'latest-linux.yml',
        'OpenPalm-1.2.3.exe', 'OpenPalm-1.2.3.AppImage',
      ]);
      expect(validateUpdaterFeeds(dir, '1.2.3', present)).toEqual([]);
    });
  });

  test('fails when a platform feed is missing entirely', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'latest.yml'), feedYaml('1.2.3', 'OpenPalm-1.2.3.exe'));
      const present = new Set(['latest.yml', 'OpenPalm-1.2.3.exe']);
      expect(validateUpdaterFeeds(dir, '1.2.3', present).join(' ')).toMatch(
        /Missing updater feed latest-linux\.yml/,
      );
    });
  });

  test('fails when a macOS feed appears — macOS is manual-download only', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'latest.yml'), feedYaml('1.2.3', 'OpenPalm-1.2.3.exe'));
      writeFileSync(join(dir, 'latest-linux.yml'), feedYaml('1.2.3', 'OpenPalm-1.2.3.AppImage'));
      const present = new Set([
        'latest.yml', 'latest-linux.yml', 'latest-mac.yml',
        'OpenPalm-1.2.3.exe', 'OpenPalm-1.2.3.AppImage',
      ]);
      expect(validateUpdaterFeeds(dir, '1.2.3', present).join(' ')).toMatch(
        /latest-mac\.yml must not be published/,
      );
    });
  });
});

// electron-builder names the feed after the version's prerelease identifier, so
// a beta candidate publishes beta.yml and no latest.yml at all. A validator that
// assumed the stable names would fail every prerelease release.
describe('feedChannelForVersion', () => {
  test('a stable version uses the latest feed', () => {
    expect(feedChannelForVersion('1.2.3')).toBe('latest');
    expect(updaterFeedsFor(feedChannelForVersion('1.2.3'))).toEqual([
      'latest.yml', 'latest-linux.yml',
    ]);
  });

  test('a prerelease version uses its own channel feed', () => {
    expect(feedChannelForVersion('0.13.0-beta.15')).toBe('beta');
    expect(updaterFeedsFor(feedChannelForVersion('0.13.0-beta.15'))).toEqual([
      'beta.yml', 'beta-linux.yml',
    ]);
    expect(feedChannelForVersion('1.0.0-alpha.1')).toBe('alpha');
  });
});

describe('validateUpdaterFeeds on a prerelease candidate', () => {
  test('accepts the beta feed and does not demand latest.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updater-feed-beta-'));
    try {
      writeFileSync(join(dir, 'beta.yml'), feedYaml('0.13.0-beta.15', 'OpenPalm-0.13.0-beta.15.exe'));
      writeFileSync(
        join(dir, 'beta-linux.yml'),
        feedYaml('0.13.0-beta.15', 'OpenPalm-0.13.0-beta.15.AppImage'),
      );
      const present = new Set([
        'beta.yml', 'beta-linux.yml',
        'OpenPalm-0.13.0-beta.15.exe', 'OpenPalm-0.13.0-beta.15.AppImage',
      ]);
      expect(validateUpdaterFeeds(dir, '0.13.0-beta.15', present)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails when a beta candidate ships no beta feed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updater-feed-beta-missing-'));
    try {
      const present = new Set(['OpenPalm-0.13.0-beta.15.exe']);
      expect(validateUpdaterFeeds(dir, '0.13.0-beta.15', present).join(' ')).toMatch(
        /Missing updater feed beta\.yml/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Cross-check with validate-release-assets.mjs's required-asset gate, added to
// close review finding D1/D4: 0.12.52 shipped a stable release with zero
// desktop assets. macOS ships a required desktop zip but stays on
// manual-download only (no signed/notarized build yet) — the two files must
// keep agreeing on that split, or a regression in one goes unnoticed by the
// other.
describe('desktop assets vs updater feeds agree on the macOS manual-download policy', () => {
  test('macOS gets a required desktop zip but no updater feed, forbidden or otherwise, changes silently', () => {
    const desktop = expectedDesktopAssets('1.2.3', 'OpenPalm');
    expect(desktop).toContain('OpenPalm-1.2.3-mac.zip');
    expect(desktop).toContain('OpenPalm-1.2.3-arm64-mac.zip');

    const channel = feedChannelForVersion('1.2.3');
    expect(updaterFeedsFor(channel).some((name) => name.includes('mac'))).toBe(false);
    expect(forbiddenFeedsFor(channel)).toEqual(['latest-mac.yml']);
  });
});
