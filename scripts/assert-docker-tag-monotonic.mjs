#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { compareSemver, parseSemver } from './set-version.mjs';

const IMAGE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SUFFIX_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MODEL_TAG_RE = /^v([1-9]\d*)$/;

function modelVersion(tag) {
  const match = tag.match(MODEL_TAG_RE);
  return match ? BigInt(match[1]) : null;
}

export function versionFromDockerTag(tag, { mode = 'semver', suffix = '' } = {}) {
  const candidate = suffix && tag.endsWith(`-${suffix}`)
    ? tag.slice(0, -(suffix.length + 1))
    : suffix
      ? ''
      : tag;
  if (mode === 'model') return modelVersion(candidate) === null ? null : candidate;
  if (mode !== 'semver') throw new Error(`Unsupported Docker tag version mode: ${mode}`);
  const normalized = candidate.startsWith('v') ? candidate.slice(1) : candidate;
  return parseSemver(normalized) ? normalized : null;
}

function compareVersions(left, right, mode) {
  if (mode === 'model') {
    const leftVersion = modelVersion(left);
    const rightVersion = modelVersion(right);
    if (leftVersion === null || rightVersion === null) throw new Error('Invalid model bundle tag');
    return leftVersion === rightVersion ? 0 : leftVersion > rightVersion ? 1 : -1;
  }
  return compareSemver(left, right);
}

export function highestDockerTagVersion(tags, options = {}) {
  const mode = options.mode ?? 'semver';
  let highest = null;
  for (const tag of tags) {
    const version = versionFromDockerTag(tag, options);
    if (version && (highest === null || compareVersions(version, highest, mode) > 0)) {
      highest = version;
    }
  }
  return highest;
}

export function assertDockerTagMonotonic(target, tags, options = {}) {
  const mode = options.mode ?? 'semver';
  if (versionFromDockerTag(`${target}${options.suffix ? `-${options.suffix}` : ''}`, options) !== target) {
    throw new Error(`Invalid ${mode === 'model' ? 'model bundle' : 'semver'} target: ${target}`);
  }
  const highest = highestDockerTagVersion(tags, options);
  if (highest !== null && compareVersions(target, highest, mode) <= 0) {
    throw new Error(`Target ${target} must be greater than existing Docker version ${highest}`);
  }
  return highest;
}

export async function fetchDockerHubTags(image, fetchImpl = fetch) {
  if (!IMAGE_RE.test(image)) throw new Error(`Invalid Docker Hub image: ${image}`);
  let url = `https://hub.docker.com/v2/repositories/${image}/tags?page_size=100`;
  const seen = new Set();
  const tags = [];

  while (url) {
    if (seen.has(url)) throw new Error('Docker Hub tag pagination repeated a page');
    seen.add(url);
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Docker Hub tag query failed for ${image}: HTTP ${response.status}`);
    const body = await response.json();
    if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
      throw new Error(`Docker Hub returned an invalid tag response for ${image}`);
    }
    for (const result of body.results) {
      if (result && typeof result === 'object' && typeof result.name === 'string') tags.push(result.name);
    }
    if (body.next !== null && typeof body.next !== 'string') {
      throw new Error(`Docker Hub returned an invalid next page for ${image}`);
    }
    if (typeof body.next === 'string' && !body.next.startsWith('https://hub.docker.com/')) {
      throw new Error(`Docker Hub returned an unexpected next page for ${image}`);
    }
    url = body.next ?? '';
  }
  return tags;
}

async function main() {
  const image = process.env.IMAGE ?? '';
  const target = process.env.TARGET_VERSION ?? '';
  const mode = process.env.TAG_MODE ?? 'semver';
  const suffix = process.env.TAG_SUFFIX ?? '';
  if (suffix && !SUFFIX_RE.test(suffix)) throw new Error(`Invalid Docker tag suffix: ${suffix}`);
  const tags = await fetchDockerHubTags(image);
  const highest = assertDockerTagMonotonic(target, tags, { mode, suffix });
  console.log(`${image}: target ${target} is newer than ${highest ?? 'no existing versioned tag'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
