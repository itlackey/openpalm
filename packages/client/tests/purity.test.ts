/**
 * P5b (#555) — purity hygiene for @openpalm/client (plan §6.11 rules, §8.5,
 * §8.10: "The client app never bundles @openpalm/lib and never holds host
 * credentials"; host capabilities are ABSENT from the artifact, not hidden).
 *
 * Two layers:
 *
 * 1. DIST GREP (RED until `bun run client:build` exists — the build output
 *    is the missing feature): every file of the built static bundle under
 *    packages/client/build/ is scanned for forbidden markers:
 *      - '@openpalm/lib'  -> the host library leaked into the artifact,
 *      - '/api/host'      -> host control-plane client code leaked in (the
 *        client talks only to per-connection guardian/OpenCode base URLs).
 *    These tests intentionally FAIL (not skip) when the build directory is
 *    absent, so a stale/missing build can never fake a green purity check.
 *    Run them after `bun run client:build`.
 *
 * 2. SOURCE HYGIENE (characterization — already green on the inert
 *    scaffold, and must stay green): package.json declares no dependency on
 *    @openpalm/lib in any dependency group, no src/lib/server/ directory
 *    exists (§6.11), and no source file imports @openpalm/lib.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_DIR = join(PKG_ROOT, 'build');

/** Markers that must never appear anywhere in the built client bundle. */
const FORBIDDEN_DIST_MARKERS = ['@openpalm/lib', '/api/host'] as const;

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function builtFiles(): string[] {
  if (!existsSync(BUILD_DIR)) {
    throw new Error(
      `client build output missing at ${BUILD_DIR} — run \`bun run client:build\` first; ` +
        'the purity checks grep the BUILT bundle, not the sources'
    );
  }
  return walk(BUILD_DIR);
}

/** Files whose bytes contain the marker ('latin1' keeps byte<->char 1:1, so
 *  ASCII markers are found even inside binary assets). */
function offenders(files: string[], marker: string): string[] {
  return files.filter((file) => readFileSync(file).toString('latin1').includes(marker));
}

describe('built bundle purity (dist grep — run after `bun run client:build`)', () => {
  test('the build output exists and is an SPA bundle (index.html fallback + js assets)', () => {
    const files = builtFiles();
    expect(files.some((file) => file.endsWith('index.html'))).toBe(true);
    expect(files.some((file) => file.endsWith('.js'))).toBe(true);
  });

  for (const marker of FORBIDDEN_DIST_MARKERS) {
    test(`no built file contains '${marker}'`, () => {
      expect(offenders(builtFiles(), marker)).toEqual([]);
    });
  }
});

describe('source hygiene (characterization — green on the scaffold, must stay green)', () => {
  test('package.json declares no dependency on @openpalm/lib in any group', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const group of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies'
    ]) {
      expect(Object.keys(pkg[group] ?? {})).not.toContain('@openpalm/lib');
    }
  });

  test('no src/lib/server/ directory exists (plan §6.11)', () => {
    expect(existsSync(join(PKG_ROOT, 'src', 'lib', 'server'))).toBe(false);
  });

  test('no source file references @openpalm/lib', () => {
    const srcDir = join(PKG_ROOT, 'src');
    const sources = existsSync(srcDir) ? walk(srcDir) : [];
    expect(offenders(sources, '@openpalm/lib')).toEqual([]);
  });
});
