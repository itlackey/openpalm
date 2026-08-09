#!/usr/bin/env node
/**
 * Gate a release on a COMPLETE desktop updater feed (#572).
 *
 * electron-updater points every installed desktop app at the newest release's
 * channel feed — latest.yml for stable, beta.yml for a beta candidate, plus the
 * x64 and arm64 Linux variants. A release that publishes those files but omits
 * (or misnames) an installer they reference does not fail at publish time — it
 * fails later, on every user's machine, as a download 404 partway through an
 * update they consented to. A release whose feed advertises a different version
 * than the release itself is worse: it can hand users an artifact from another
 * build entirely.
 *
 * So this refuses to publish unless, for each updater-capable platform:
 *   - the feed file exists and parses,
 *   - its `version` matches the release version exactly,
 *   - every file it references is present in the upload set,
 *   - every declared sha512 matches the referenced artifact bytes,
 *   - top-level path/sha512 agrees with files[], and
 *   - each feed selects its exact platform/architecture artifact.
 *
 * macOS is deliberately absent: it stays on the manual download path until the
 * app is signed and notarized, so it publishes no feed (electron-builder.yml
 * sets `mac.publish: null`). A <channel>-mac.yml appearing here means that
 * policy regressed, and is treated as an error rather than silently accepted.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The channel feed a release must publish for `version`.
 *
 * Desktop clients only ever request TWO channel feeds: stable installs fetch
 * `latest.yml` and prerelease-opted installs fetch `beta.yml` — see
 * packages/electron/src/updater.ts (updaterChannel/updaterFeedChannel), which
 * deliberately defines no other channel. So ANY prerelease collapses to
 * `beta`, whatever its first identifier says: naming the feed after the
 * identifier (rc.yml, alpha.yml) would ship files no installed app requests
 * while beta-channel installs 404 on the beta.yml they do request.
 *
 * release.yml's assemble-assets step renames the electron-builder feeds via
 * this same function, so the rename mapping and this gate cannot disagree.
 */
export function feedChannelForVersion(version) {
  const match = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z-]+))/.exec(version.trim());
  return match ? 'beta' : 'latest';
}

/**
 * Feed files electron-updater consumes for `channel`, by platform+arch.
 *
 * electron-builder writes a SEPARATE Linux feed per arch:
 * `getArchPrefixForUpdateFile` (app-builder-lib) appends `-arm64` to the
 * update-info filename for any non-x64 Linux build, and electron-updater's
 * `Provider.getChannelFilePrefix()` requests exactly that file on an arm64
 * Linux install. `packages/electron/electron-builder.yml`'s `linux.target`
 * builds AppImage for BOTH x64 and arm64 (mirrored in DESKTOP_TARGETS in
 * validate-release-assets.mjs), so both `${channel}-linux.yml` (x64) and
 * `${channel}-linux-arm64.yml` (arm64) are required feeds — omitting the
 * arm64 one leaves a required, shipped, updater-capable target ungated
 * (review finding #4).
 */
export function updaterFeedsFor(channel) {
  return [`${channel}.yml`, `${channel}-linux.yml`, `${channel}-linux-arm64.yml`];
}

/** Feeds that must NOT be published while that platform is manual-only. */
export function forbiddenFeedsFor(channel) {
  return [`${channel}-mac.yml`];
}

/**
 * Bind each feed to the one artifact electron-builder produced for it.
 */
export function updaterArtifactForFeed(name, version, productName = 'OpenPalm') {
  const channel = feedChannelForVersion(version);
  if (name === `${channel}.yml`) {
    const artifact = `${productName}-Setup-${version}.exe`;
    return { feedArtifact: artifact, physicalArtifact: artifact };
  }
  if (name === `${channel}-linux.yml`) {
    const artifact = `${productName}-${version}.AppImage`;
    return { feedArtifact: artifact, physicalArtifact: artifact };
  }
  if (name === `${channel}-linux-arm64.yml`) {
    const artifact = `${productName}-${version}-arm64.AppImage`;
    return { feedArtifact: artifact, physicalArtifact: artifact };
  }
  return null;
}

/**
 * Minimal reader for the electron-updater feed shape. Deliberately not a
 * general YAML parser: the feed is a fixed, machine-generated document, and
 * pulling in a parser to read four known keys would add a dependency to a
 * release gate that must not itself become a failure mode.
 *
 * Shape:
 *   version: 1.2.3
 *   path: OpenPalm-Setup-1.2.3.exe
 *   sha512: <base64>
 *   files:
 *     - url: OpenPalm-Setup-1.2.3.exe
 *       sha512: <base64>
 *       size: 123
 */
export function parseUpdaterFeed(text) {
  const feed = { version: null, path: null, sha512: null, files: [] };
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const topLevel = line.match(/^(version|path|sha512):\s*(.*)$/);
    if (topLevel) {
      feed[topLevel[1]] = unquote(topLevel[2]);
      current = null;
      continue;
    }
    // A new list entry always starts with "- ", optionally carrying its first key.
    const entry = line.match(/^\s*-\s+(\w+):\s*(.*)$/);
    if (entry) {
      current = { [entry[1]]: unquote(entry[2]) };
      feed.files.push(current);
      continue;
    }
    const nested = line.match(/^\s+(\w+):\s*(.*)$/);
    if (nested && current) current[nested[1]] = unquote(nested[2]);
  }
  return feed;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Validate one feed against the files actually being uploaded. Returns the list
 * of problems found (empty means valid) rather than throwing, so a caller can
 * report every fault in one run instead of one per re-run.
 */
export function validateFeed(name, text, version, dir, presentFiles, productName = 'OpenPalm') {
  const problems = [];
  const feed = parseUpdaterFeed(text);
  const expectedArtifact = updaterArtifactForFeed(name, version, productName);

  if (!feed.version) {
    problems.push(`${name}: no version field`);
  } else if (feed.version !== version) {
    problems.push(`${name}: version ${feed.version} does not match release ${version}`);
  }

  // `path` is what the updater downloads; `files[]` is the full set it may pick
  // from. Both must identify the same primary artifact and resolve to files
  // actually being uploaded.
  const referenced = new Set();
  if (feed.path) {
    referenced.add(feed.path);
  } else {
    problems.push(`${name}: no top-level path`);
  }
  if (!feed.sha512) problems.push(`${name}: top-level path has no sha512`);

  for (const file of feed.files) {
    if (file.url) referenced.add(file.url);
    if (!file.sha512) problems.push(`${name}: ${file.url ?? '(unnamed entry)'} has no sha512`);
  }
  if (referenced.size === 0) problems.push(`${name}: references no installer`);

  if (feed.path) {
    const primary = feed.files.find((file) => file.url === feed.path);
    if (!primary) {
      problems.push(`${name}: top-level path ${feed.path} is not present in files[]`);
    } else if (feed.sha512 && primary.sha512 !== feed.sha512) {
      problems.push(`${name}: top-level sha512 does not match files[] for ${feed.path}`);
    }

    if (expectedArtifact && feed.path !== expectedArtifact.feedArtifact) {
      problems.push(
        `${name}: path ${feed.path} does not match required artifact ${expectedArtifact.feedArtifact}`,
      );
    }
  }

  for (const file of referenced) {
    const physicalFile =
      expectedArtifact && file === expectedArtifact.feedArtifact
        ? expectedArtifact.physicalArtifact
        : file;
    if (!presentFiles.has(physicalFile) || !existsSync(join(dir, physicalFile))) {
      const physicalNote = physicalFile === file ? '' : ` (physical artifact ${physicalFile})`;
      problems.push(`${name}: references missing asset ${file}${physicalNote}`);
    }
  }

  const verified = new Set();
  const verifySha512 = (file, expected, label) => {
    if (!file || !expected) return;
    const physicalFile =
      expectedArtifact && file === expectedArtifact.feedArtifact
        ? expectedArtifact.physicalArtifact
        : file;
    if (!presentFiles.has(physicalFile) || !existsSync(join(dir, physicalFile))) return;
    const key = `${physicalFile}\0${expected}`;
    if (verified.has(key)) return;
    verified.add(key);
    const actual = createHash('sha512')
      .update(readFileSync(join(dir, physicalFile)))
      .digest('base64');
    if (actual !== expected) {
      problems.push(`${name}: ${label} sha512 does not match ${physicalFile}`);
    }
  };

  verifySha512(feed.path, feed.sha512, 'top-level');
  for (const file of feed.files) verifySha512(file.url, file.sha512, 'files[]');

  return problems;
}

/** Validate every feed in `dir` for `version`. Returns all problems found. */
export function validateUpdaterFeeds(dir, version, presentFiles, productName = 'OpenPalm') {
  const problems = [];
  const channel = feedChannelForVersion(version);
  for (const forbidden of forbiddenFeedsFor(channel)) {
    if (presentFiles.has(forbidden)) {
      problems.push(
        `${forbidden} must not be published: that platform is manual-download only until it is signed and notarized`,
      );
    }
  }
  for (const name of updaterFeedsFor(channel)) {
    if (!presentFiles.has(name)) {
      problems.push(`Missing updater feed ${name} — installed desktop apps on the ${channel} channel update from it`);
      continue;
    }
    problems.push(
      ...validateFeed(
        name,
        readFileSync(join(dir, name), 'utf8'),
        version,
        dir,
        presentFiles,
        productName,
      ),
    );
  }
  return problems;
}

// Run as a script (not when imported by tests).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ''))) {
  const dir = process.env.UPDATER_DIR ?? 'dist';
  const version = process.env.VERSION;
  if (!version) throw new Error('VERSION is required');
  if (!existsSync(dir)) throw new Error(`Missing upload directory ${dir}`);

  const present = new Set(readdirSync(dir));
  const problems = validateUpdaterFeeds(dir, version, present);
  if (problems.length > 0) {
    console.error('Desktop updater feed is incomplete:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const feeds = updaterFeedsFor(feedChannelForVersion(version));
  console.log(`Desktop updater feed OK for ${version} (${feeds.join(', ')})`);
}
