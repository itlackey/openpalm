#!/usr/bin/env node
/**
 * Gate a release on a COMPLETE desktop updater feed (#572).
 *
 * electron-updater points every installed desktop app at the newest release's
 * latest.yml / latest-linux.yml. A release that publishes those files but omits
 * (or misnames) an installer they reference does not fail at publish time — it
 * fails later, on every user's machine, as a download 404 partway through an
 * update they consented to. A release whose feed advertises a different version
 * than the release itself is worse: it can hand users an artifact from another
 * build entirely.
 *
 * So this refuses to publish unless, for each updater-capable platform:
 *   - the feed file exists and parses,
 *   - its `version` matches the release version exactly,
 *   - every file it references is present in the upload set, and
 *   - every referenced file carries a sha512.
 *
 * macOS is deliberately absent: it stays on the manual download path until the
 * app is signed and notarized, so it publishes no feed (electron-builder.yml
 * sets `mac.publish: null`). A latest-mac.yml appearing here means that policy
 * regressed, and is treated as an error rather than silently accepted.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Feed files electron-updater consumes, by platform. */
export const UPDATER_FEEDS = ['latest.yml', 'latest-linux.yml'];
/** Feeds that must NOT be published while that platform is manual-only. */
export const FORBIDDEN_FEEDS = ['latest-mac.yml'];

/**
 * Minimal reader for the electron-updater feed shape. Deliberately not a
 * general YAML parser: the feed is a fixed, machine-generated document, and
 * pulling in a parser to read four known keys would add a dependency to a
 * release gate that must not itself become a failure mode.
 *
 * Shape:
 *   version: 1.2.3
 *   path: OpenPalm-1.2.3.exe
 *   sha512: <base64>
 *   files:
 *     - url: OpenPalm-1.2.3.exe
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
export function validateFeed(name, text, version, presentFiles) {
  const problems = [];
  const feed = parseUpdaterFeed(text);

  if (!feed.version) {
    problems.push(`${name}: no version field`);
  } else if (feed.version !== version) {
    problems.push(`${name}: version ${feed.version} does not match release ${version}`);
  }

  // `path` is what the updater downloads; `files[]` is the full set it may pick
  // from. Both must resolve to something actually uploaded.
  const referenced = new Set();
  if (feed.path) referenced.add(feed.path);
  for (const file of feed.files) {
    if (file.url) referenced.add(file.url);
    if (!file.sha512) problems.push(`${name}: ${file.url ?? '(unnamed entry)'} has no sha512`);
  }
  if (referenced.size === 0) problems.push(`${name}: references no installer`);
  if (feed.path && !feed.sha512) problems.push(`${name}: top-level path has no sha512`);

  for (const file of referenced) {
    if (!presentFiles.has(file)) {
      problems.push(`${name}: references missing asset ${file}`);
    }
  }
  return problems;
}

/** Validate every feed in `dir` for `version`. Returns all problems found. */
export function validateUpdaterFeeds(dir, version, presentFiles) {
  const problems = [];
  for (const forbidden of FORBIDDEN_FEEDS) {
    if (presentFiles.has(forbidden)) {
      problems.push(
        `${forbidden} must not be published: that platform is manual-download only until it is signed and notarized`,
      );
    }
  }
  for (const name of UPDATER_FEEDS) {
    if (!presentFiles.has(name)) {
      problems.push(`Missing updater feed ${name} — installed desktop apps update from it`);
      continue;
    }
    problems.push(...validateFeed(name, readFileSync(join(dir, name), 'utf8'), version, presentFiles));
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
  console.log(`Desktop updater feed OK for ${version} (${UPDATER_FEEDS.join(', ')})`);
}
