// Release gate for the desktop updater feed (#572). A release that ships
// latest.yml but not the installer it names breaks updates for every installed
// desktop app, so these cases pin the failure modes that gate must catch.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseUpdaterFeed,
  validateFeed,
  validateUpdaterFeeds,
} from './validate-updater-feed.mjs';

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
