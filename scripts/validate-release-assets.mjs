#!/usr/bin/env node
/**
 * Gate a release on shipping the COMPLETE product, not just the CLI.
 *
 * CLI-only releases are no longer a supported outcome
 * (docs/reviews/onboarding-setup-review.md, D1/D4): the latest stable release
 * (0.12.52) shipped with zero desktop assets while the README told users to
 * download the desktop app from it, because this gate only ever checked the
 * five CLI binaries. A release is now invalid unless it carries:
 *   - the CLI binary for every platform (matches the `cli` job matrix in
 *     release.yml — see CLI_BINARIES below),
 *   - the desktop artifact for every target electron-builder produces
 *     (packages/electron/electron-builder.yml's mac/win/linux `target` lists),
 *   - the electron-updater feed files for the release's channel (derived from
 *     validate-updater-feed.mjs — the single place that already knows how
 *     electron-builder names them), and
 *   - checksums-sha256.txt, covering every one of the above.
 *
 * Desktop artifact names are DERIVED from `version` using electron-builder's
 * own default naming rules rather than hard-coded per release, so this stays
 * correct without hand-editing as versions change. See expectedDesktopAssets
 * for exactly how each name is built and where that rule comes from.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedChannelForVersion, updaterFeedsFor } from './validate-updater-feed.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_BUILDER_YML = join(REPO_ROOT, 'packages/electron/electron-builder.yml');

/**
 * CLI binary assets, one per `cli` job matrix entry in release.yml. Kept as a
 * plain list (not parsed out of the workflow YAML) because a GitHub Actions
 * matrix must stay static; release-aggregates-hygiene.test.ts cross-checks
 * this list against that matrix so the two cannot drift silently, and
 * release.yml's publish-bootstrap job imports this list instead of keeping a
 * third copy.
 */
export const CLI_BINARIES = [
  'openpalm-cli-linux-x64',
  'openpalm-cli-linux-arm64',
  'openpalm-cli-darwin-x64',
  'openpalm-cli-darwin-arm64',
  'openpalm-cli-windows-x64.exe',
];

/**
 * The `productName` electron-builder.yml declares. Read from the file rather
 * than duplicated here so a rename doesn't require touching this validator —
 * intentionally not a general YAML parser (same rationale as
 * validate-updater-feed.mjs's parseUpdaterFeed): this file is short,
 * human-maintained, and `productName:` is a single top-level scalar.
 */
export function readElectronProductName(path = ELECTRON_BUILDER_YML) {
  const text = readFileSync(path, 'utf8');
  const match = /^productName:\s*(.+?)\s*$/m.exec(text);
  if (!match) throw new Error(`Could not find productName in ${path}`);
  const value = match[1].trim();
  return value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
}

const DEFAULT_ARCH = 'x64';

/**
 * Desktop targets electron-builder.yml configures, one entry per artifact it
 * produces. Update this alongside electron-builder.yml's mac/win/linux
 * `target` lists if a platform or arch is ever added or removed — it is the
 * one place in this validator that encodes that table.
 *
 *   mac:   zip,   arch [arm64, x64]
 *   win:   nsis,  arch [x64]   (the updater-capable installer)
 *          zip,   arch [x64]   (manual/portable download, no updater feed)
 *   linux: AppImage, arch [x64, arm64]
 */
const DESKTOP_TARGETS = [
  { platform: 'mac', arch: 'arm64', kind: 'zip' },
  { platform: 'mac', arch: 'x64', kind: 'zip' },
  { platform: 'win', arch: 'x64', kind: 'nsis' },
  { platform: 'win', arch: 'x64', kind: 'zip' },
  { platform: 'linux', arch: 'x64', kind: 'appimage' },
  { platform: 'linux', arch: 'arm64', kind: 'appimage' },
];

/**
 * Name one desktop artifact the way electron-builder actually names it
 * (traced from the installed electron-builder package):
 *   - zip (mac/win):    default pattern, electron-builder.yml sets no
 *                       `artifactName` for these — "${productName}-${version}[-${arch}]-${os}.zip"
 *   - AppImage (linux): same, no override — "${productName}-${version}[-${arch}].AppImage"
 *   - nsis (win):       electron-builder.yml SETS `nsis.artifactName` to
 *                       "${productName}-Setup-${version}.${ext}" (review
 *                       finding #1): the built-in default
 *                       "${productName} Setup ${version}.${ext}" contains a
 *                       space, which is not a valid GitHub release asset
 *                       character — app-builder-lib's
 *                       computeSafeArtifactNameIfNeeded rewrites it to
 *                       "${productName}-Setup-${version}.exe" for the
 *                       electron-updater feed (updateInfoBuilder.js) while
 *                       the on-disk file kept the space, so the feed
 *                       referenced a file that was never uploaded. Setting
 *                       the artifactName explicitly makes the on-disk name,
 *                       the feed, and the GitHub-uploaded asset all agree.
 * The `-${arch}` segment is dropped for the configured default arch (x64);
 * every non-default arch (arm64) keeps it. NSIS only ever builds x64 (see
 * DESKTOP_TARGETS), so it never carries an arch suffix.
 */
export function desktopAssetName(productName, version, { platform, arch, kind }) {
  const archSuffix = arch === DEFAULT_ARCH ? '' : `-${arch}`;
  switch (kind) {
    case 'zip':
      return `${productName}-${version}${archSuffix}-${platform}.zip`;
    case 'appimage':
      return `${productName}-${version}${archSuffix}.AppImage`;
    case 'nsis':
      return `${productName}-Setup-${version}${archSuffix}.exe`;
    default:
      throw new Error(`Unknown desktop target kind: ${kind}`);
  }
}

/** Every desktop artifact the release must carry, one per DESKTOP_TARGETS entry. */
export function expectedDesktopAssets(version, productName = readElectronProductName()) {
  return DESKTOP_TARGETS.map((target) => desktopAssetName(productName, version, target));
}

/**
 * The electron-updater feed files for `version`'s channel. Delegates to
 * validate-updater-feed.mjs so the channel-naming rule (stable → latest.yml,
 * a prerelease → its own channel, e.g. beta.yml) lives in exactly one place.
 */
export function expectedUpdaterFeeds(version) {
  return updaterFeedsFor(feedChannelForVersion(version));
}

/** The complete required-asset set for `version`: CLI + desktop + updater feed + checksums. */
export function requiredReleaseAssets(version, productName = readElectronProductName()) {
  return [
    ...CLI_BINARIES,
    ...expectedDesktopAssets(version, productName),
    ...expectedUpdaterFeeds(version),
    'checksums-sha256.txt',
  ];
}

/**
 * Look up the sha256 `checksums-sha256.txt` (as written by `sha256sum --`)
 * records for `filename`. A plain `split(/\s+/)` would break on any asset
 * name that ever contains a space (the NSIS installer used to, before review
 * finding #1 gave it an explicit GitHub-safe `artifactName`) — this matches
 * only on the fixed 64-hex-char hash prefix so the remainder, spaces
 * included, is taken as the filename, staying correct if that ever recurs.
 */
export function checksumFor(checksumsText, filename) {
  for (const rawLine of checksumsText.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (match && match[2] === filename) return match[1];
  }
  return undefined;
}

/**
 * Validate the asset set in `dir` against `version`. Returns every problem
 * found (empty means valid) instead of throwing on the first one, so a single
 * run reports the complete gap rather than one missing asset per re-run.
 */
export function validateReleaseAssets(dir, version, productName = readElectronProductName()) {
  const problems = [];
  const manifestPath = join(dir, 'release-assets-manifest.json');
  if (!existsSync(manifestPath)) {
    problems.push(`Missing ${manifestPath}`);
    return problems;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version || !Array.isArray(manifest.assets)) {
    problems.push('Release asset manifest has the wrong version or asset list');
  }

  const assets = new Set(Array.isArray(manifest.assets) ? manifest.assets : []);
  const required = requiredReleaseAssets(version, productName);
  for (const name of required) {
    if (!assets.has(name) || !existsSync(join(dir, name))) {
      problems.push(`Missing release asset: ${name}`);
    }
  }

  const checksumsPath = join(dir, 'checksums-sha256.txt');
  if (!existsSync(checksumsPath)) {
    problems.push('Missing checksums-sha256.txt');
    return problems;
  }
  const checksums = readFileSync(checksumsPath, 'utf8');
  for (const name of required) {
    if (name === 'checksums-sha256.txt' || !existsSync(join(dir, name))) continue; // already reported above
    const expected = checksumFor(checksums, name);
    if (!expected) {
      problems.push(`Missing checksum for ${name}`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
    if (actual !== expected) problems.push(`Checksum mismatch for ${name}`);
  }

  return problems;
}

// Run as a script (not when imported by tests).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ''))) {
  const dir = process.env.RELEASE_ASSETS_DIR ?? 'dist';
  const version = process.env.VERSION;
  if (!version) throw new Error('VERSION is required');

  const problems = validateReleaseAssets(dir, version);
  if (problems.length > 0) {
    console.error(`Release asset set for ${version} is incomplete:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Validated ${requiredReleaseAssets(version).length} required release assets for ${version}`);
}
