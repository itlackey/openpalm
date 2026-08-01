// Release gate for the desktop updater feed (#572). A release that ships
// latest.yml but not the installer it names breaks updates for every installed
// desktop app, so these cases pin the failure modes that gate must catch.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  feedChannelForVersion,
  forbiddenFeedsFor,
  parseUpdaterFeed,
  updaterArtifactForFeed,
  updaterFeedsFor,
  validateFeed,
  validateUpdaterFeeds,
} from './validate-updater-feed.mjs';
import { expectedDesktopAssets } from './validate-release-assets.mjs';

const ARTIFACT_CONTENT = 'desktop-artifact';
const WINDOWS_FEED_ARTIFACT = 'OpenPalm-Setup-1.2.3.exe';
const WINDOWS_PHYSICAL_ARTIFACT = WINDOWS_FEED_ARTIFACT;
const LINUX_X64_ARTIFACT = 'OpenPalm-1.2.3.AppImage';
const LINUX_ARM64_ARTIFACT = 'OpenPalm-1.2.3-arm64.AppImage';

function sha512(content: string): string {
  return createHash('sha512').update(content).digest('base64');
}

function feedYaml(
  version: string,
  file: string,
  content = ARTIFACT_CONTENT,
  options: { path?: string; fileSha512?: string; topSha512?: string } = {},
): string {
  const fileSha512 = options.fileSha512 ?? sha512(content);
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${file}`,
    `    sha512: ${fileSha512}`,
    '    size: 12345',
    '    blockMapSize: 2345',
    `path: ${options.path ?? file}`,
    `sha512: ${options.topSha512 ?? fileSha512}`,
    `releaseDate: '2026-07-30T00:00:00.000Z'`,
    '',
  ].join('\n');
}

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'updater-feed-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeArtifact(dir: string, file: string, content = ARTIFACT_CONTENT): void {
  writeFileSync(join(dir, file), content);
}

describe('parseUpdaterFeed', () => {
  test('reads version, path, sha512 and the files list', () => {
    const feed = parseUpdaterFeed(feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT));
    expect(feed.version).toBe('1.2.3');
    expect(feed.path).toBe(WINDOWS_FEED_ARTIFACT);
    expect(feed.sha512).toBe(sha512(ARTIFACT_CONTENT));
    expect(feed.files).toEqual([
      {
        url: WINDOWS_FEED_ARTIFACT,
        sha512: sha512(ARTIFACT_CONTENT),
        size: '12345',
        blockMapSize: '2345',
      },
    ]);
  });

  test('strips quotes that electron-builder adds around some versions', () => {
    expect(parseUpdaterFeed("version: '1.2.3-beta.1'\n").version).toBe('1.2.3-beta.1');
  });
});

describe('validateFeed', () => {
  const present = new Set([WINDOWS_PHYSICAL_ARTIFACT, 'latest.yml']);

  test('accepts electron-builder\'s safe Windows feed and NSIS filename', () => {
    withDir((dir) => {
      writeArtifact(dir, WINDOWS_PHYSICAL_ARTIFACT);
      const problems = validateFeed(
        'latest.yml', feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT), '1.2.3', dir, present,
      );
      expect(problems).toEqual([]);
    });
  });

  test('rejects a feed advertising a different version than the release', () => {
    withDir((dir) => {
      writeArtifact(dir, WINDOWS_PHYSICAL_ARTIFACT);
      const problems = validateFeed(
        'latest.yml', feedYaml('1.2.2', WINDOWS_FEED_ARTIFACT), '1.2.3', dir, present,
      );
      expect(problems.join(' ')).toMatch(/does not match release 1\.2\.3/);
    });
  });

  test('rejects a feed referencing an installer that is not being uploaded', () => {
    withDir((dir) => {
      const problems = validateFeed(
        'latest.yml', feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT), '1.2.3', dir, present,
      );
      expect(problems.join(' ')).toMatch(
        /references missing asset OpenPalm-Setup-1\.2\.3\.exe/,
      );
    });
  });

  test('rejects an entry with no sha512 — corruption would go undetected', () => {
    withDir((dir) => {
      writeArtifact(dir, WINDOWS_PHYSICAL_ARTIFACT);
      const yaml = ['version: 1.2.3', 'files:', `  - url: ${WINDOWS_FEED_ARTIFACT}`, '    size: 1', ''].join('\n');
      const problems = validateFeed('latest.yml', yaml, '1.2.3', dir, present);
      expect(problems.join(' ')).toMatch(/has no sha512/);
    });
  });

  test('rejects a feed that references no installer at all', () => {
    withDir((dir) => {
      const problems = validateFeed('latest.yml', 'version: 1.2.3\n', '1.2.3', dir, present);
      expect(problems.join(' ')).toMatch(/references no installer/);
    });
  });

  test('rejects a sha512 that does not match the referenced artifact bytes', () => {
    withDir((dir) => {
      writeArtifact(dir, WINDOWS_PHYSICAL_ARTIFACT, 'corrupted');
      const problems = validateFeed(
        'latest.yml', feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT), '1.2.3', dir, present,
      );
      expect(problems.join(' ')).toMatch(/sha512 does not match OpenPalm-Setup-1\.2\.3\.exe/);
    });
  });

  test('rejects top-level path and sha512 values that disagree with files[]', () => {
    withDir((dir) => {
      writeArtifact(dir, WINDOWS_PHYSICAL_ARTIFACT);
      const pathProblems = validateFeed(
        'latest.yml',
        feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT, ARTIFACT_CONTENT, { path: 'Other.exe' }),
        '1.2.3',
        dir,
        present,
      );
      expect(pathProblems.join(' ')).toMatch(/top-level path Other\.exe is not present in files\[\]/);

      const shaProblems = validateFeed(
        'latest.yml',
        feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT, ARTIFACT_CONTENT, { topSha512: sha512('other') }),
        '1.2.3',
        dir,
        present,
      );
      expect(shaProblems.join(' ')).toMatch(/top-level sha512 does not match files\[\]/);
    });
  });

  test('binds every feed to its exact platform and architecture artifact', () => {
    withDir((dir) => {
      writeArtifact(dir, 'OpenPalm-1.2.3-win.zip');
      writeArtifact(dir, LINUX_X64_ARTIFACT);
      writeArtifact(dir, LINUX_ARM64_ARTIFACT);
      const windows = validateFeed(
        'latest.yml',
        feedYaml('1.2.3', 'OpenPalm-1.2.3-win.zip'),
        '1.2.3',
        dir,
        new Set(['OpenPalm-1.2.3-win.zip']),
      );
      const linux = validateFeed(
        'latest-linux.yml',
        feedYaml('1.2.3', LINUX_ARM64_ARTIFACT),
        '1.2.3',
        dir,
        new Set([LINUX_ARM64_ARTIFACT]),
      );
      const linuxArm64 = validateFeed(
        'latest-linux-arm64.yml',
        feedYaml('1.2.3', LINUX_X64_ARTIFACT),
        '1.2.3',
        dir,
        new Set([LINUX_X64_ARTIFACT]),
      );
      expect(windows.join(' ')).toMatch(/does not match required artifact OpenPalm-Setup-1\.2\.3\.exe/);
      expect(linux.join(' ')).toMatch(/does not match required artifact OpenPalm-1\.2\.3\.AppImage/);
      expect(linuxArm64.join(' ')).toMatch(
        /does not match required artifact OpenPalm-1\.2\.3-arm64\.AppImage/,
      );
    });
  });
});

describe('validateUpdaterFeeds', () => {
  test('passes realistic Windows, Linux x64, and Linux arm64 feeds', () => {
    withDir((dir) => {
      writeArtifact(dir, WINDOWS_PHYSICAL_ARTIFACT);
      writeArtifact(dir, LINUX_X64_ARTIFACT);
      writeArtifact(dir, LINUX_ARM64_ARTIFACT);
      writeFileSync(join(dir, 'latest.yml'), feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT));
      writeFileSync(join(dir, 'latest-linux.yml'), feedYaml('1.2.3', LINUX_X64_ARTIFACT));
      writeFileSync(
        join(dir, 'latest-linux-arm64.yml'),
        feedYaml('1.2.3', LINUX_ARM64_ARTIFACT),
      );
      const present = new Set([
        'latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml',
        WINDOWS_PHYSICAL_ARTIFACT, LINUX_X64_ARTIFACT, LINUX_ARM64_ARTIFACT,
      ]);
      expect(validateUpdaterFeeds(dir, '1.2.3', present)).toEqual([]);
    });
  });

  test('verifies the arm64 feed SHA-512 against the arm64 AppImage bytes', () => {
    withDir((dir) => {
      writeArtifact(dir, LINUX_ARM64_ARTIFACT, 'corrupted-arm64');
      const problems = validateFeed(
        'latest-linux-arm64.yml',
        feedYaml('1.2.3', LINUX_ARM64_ARTIFACT),
        '1.2.3',
        dir,
        new Set([LINUX_ARM64_ARTIFACT]),
      );
      expect(problems.join(' ')).toMatch(
        /sha512 does not match OpenPalm-1\.2\.3-arm64\.AppImage/,
      );
    });
  });

  test('fails when a platform feed is missing entirely', () => {
    withDir((dir) => {
      writeArtifact(dir, WINDOWS_PHYSICAL_ARTIFACT);
      writeFileSync(join(dir, 'latest.yml'), feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT));
      const present = new Set(['latest.yml', WINDOWS_PHYSICAL_ARTIFACT]);
      expect(validateUpdaterFeeds(dir, '1.2.3', present).join(' ')).toMatch(
        /Missing updater feed latest-linux\.yml/,
      );
    });
  });

  test('fails when the arm64 Linux feed is missing — the x64 feed alone does not cover an arm64 AppImage install (review finding #4)', () => {
    withDir((dir) => {
      writeArtifact(dir, WINDOWS_PHYSICAL_ARTIFACT);
      writeArtifact(dir, LINUX_X64_ARTIFACT);
      writeArtifact(dir, LINUX_ARM64_ARTIFACT);
      writeFileSync(join(dir, 'latest.yml'), feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT));
      writeFileSync(join(dir, 'latest-linux.yml'), feedYaml('1.2.3', LINUX_X64_ARTIFACT));
      const present = new Set([
        'latest.yml', 'latest-linux.yml',
        WINDOWS_PHYSICAL_ARTIFACT, LINUX_X64_ARTIFACT, LINUX_ARM64_ARTIFACT,
      ]);
      expect(validateUpdaterFeeds(dir, '1.2.3', present).join(' ')).toMatch(
        /Missing updater feed latest-linux-arm64\.yml/,
      );
    });
  });

  test('fails when a macOS feed appears — macOS is manual-download only', () => {
    withDir((dir) => {
      writeArtifact(dir, WINDOWS_PHYSICAL_ARTIFACT);
      writeArtifact(dir, LINUX_X64_ARTIFACT);
      writeArtifact(dir, LINUX_ARM64_ARTIFACT);
      writeFileSync(join(dir, 'latest.yml'), feedYaml('1.2.3', WINDOWS_FEED_ARTIFACT));
      writeFileSync(join(dir, 'latest-linux.yml'), feedYaml('1.2.3', LINUX_X64_ARTIFACT));
      writeFileSync(join(dir, 'latest-linux-arm64.yml'), feedYaml('1.2.3', LINUX_ARM64_ARTIFACT));
      const present = new Set([
        'latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'latest-mac.yml',
        WINDOWS_PHYSICAL_ARTIFACT, LINUX_X64_ARTIFACT, LINUX_ARM64_ARTIFACT,
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
      'latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml',
    ]);
  });

  test('a prerelease version uses its own channel feed', () => {
    expect(feedChannelForVersion('0.13.0-beta.15')).toBe('beta');
    expect(updaterFeedsFor(feedChannelForVersion('0.13.0-beta.15'))).toEqual([
      'beta.yml', 'beta-linux.yml', 'beta-linux-arm64.yml',
    ]);
    expect(feedChannelForVersion('1.0.0-alpha.1')).toBe('alpha');
  });
});

describe('validateUpdaterFeeds on a prerelease candidate', () => {
  test('accepts the beta feed and does not demand latest.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updater-feed-beta-'));
    try {
      writeArtifact(dir, 'OpenPalm-Setup-0.13.0-beta.15.exe');
      writeArtifact(dir, 'OpenPalm-0.13.0-beta.15.AppImage');
      writeArtifact(dir, 'OpenPalm-0.13.0-beta.15-arm64.AppImage');
      writeFileSync(join(dir, 'beta.yml'), feedYaml('0.13.0-beta.15', 'OpenPalm-Setup-0.13.0-beta.15.exe'));
      writeFileSync(
        join(dir, 'beta-linux.yml'),
        feedYaml('0.13.0-beta.15', 'OpenPalm-0.13.0-beta.15.AppImage'),
      );
      writeFileSync(
        join(dir, 'beta-linux-arm64.yml'),
        feedYaml('0.13.0-beta.15', 'OpenPalm-0.13.0-beta.15-arm64.AppImage'),
      );
      const present = new Set([
        'beta.yml', 'beta-linux.yml', 'beta-linux-arm64.yml',
        'OpenPalm-Setup-0.13.0-beta.15.exe', 'OpenPalm-0.13.0-beta.15.AppImage',
        'OpenPalm-0.13.0-beta.15-arm64.AppImage',
      ]);
      expect(validateUpdaterFeeds(dir, '0.13.0-beta.15', present)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails when a beta candidate ships no beta feed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updater-feed-beta-missing-'));
    try {
      const present = new Set(['OpenPalm-Setup-0.13.0-beta.15.exe']);
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

describe('updaterArtifactForFeed', () => {
  test('maps electron-builder feed names to their physical artifacts', () => {
    expect(updaterArtifactForFeed('latest.yml', '1.2.3')).toEqual({
      feedArtifact: WINDOWS_FEED_ARTIFACT,
      physicalArtifact: WINDOWS_PHYSICAL_ARTIFACT,
    });
    expect(updaterArtifactForFeed('latest-linux.yml', '1.2.3')?.physicalArtifact).toBe(
      LINUX_X64_ARTIFACT,
    );
    expect(updaterArtifactForFeed('latest-linux-arm64.yml', '1.2.3')?.physicalArtifact).toBe(
      LINUX_ARM64_ARTIFACT,
    );
  });
});
