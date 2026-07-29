/** GitHub Release host-assets transport shared by CLI, admin, and Electron. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { x as extract } from 'tar';
import { errMessage } from './errors.js';
import { retry } from './retry.js';
import { compareComparableVersions, distTagForVersion, isComparableSemver, normalizeVersion } from './versioning.js';

export const GITHUB_REPOSITORY = 'itlackey/openpalm';
export const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;

export type HostAssetsChannel = 'stable' | 'prerelease';
export type HostAssetsManifest = {
  platformVersion: string;
  minHarnessContract: number;
};
export type HostAssetsRelease = {
  version: string;
  assetUrl: string;
  checksumUrl: string;
  manifest: HostAssetsManifest;
};

type GithubRelease = { tag_name?: string; prerelease?: boolean; draft?: boolean; assets?: Array<{ name?: string; browser_download_url?: string }> };

async function githubFetch(url: string): Promise<Response> {
  return retry(async () => {
    const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openpalm-host-assets' }, signal: AbortSignal.timeout(60_000) });
    if (response.status >= 500) throw new Error(`GitHub returned HTTP ${response.status}`);
    return response;
  }, { delays: [0, 200, 400] });
}

function releaseVersion(release: GithubRelease): string {
  const version = normalizeVersion(release.tag_name);
  if (!isComparableSemver(version)) throw new Error('GitHub release has no usable tag');
  return version;
}

function releaseAsset(release: GithubRelease, version: string): HostAssetsRelease {
  const assets = release.assets ?? [];
  const assetName = `openpalm-host-assets-${version}.tar.gz`;
  const asset = assets.find(item => item.name === assetName && item.browser_download_url);
  const checksum = assets.find(item => (item.name === `${assetName}.sha256` || item.name === `${assetName}.sha256sum`) && item.browser_download_url);
  if (!asset?.browser_download_url || !checksum?.browser_download_url) throw new Error(`Release ${version} is missing ${assetName} or its checksum`);
  return { version, assetUrl: asset.browser_download_url, checksumUrl: checksum.browser_download_url, manifest: { platformVersion: version, minHarnessContract: 0 } };
}

async function readRelease(url: string): Promise<GithubRelease> {
  const response = await githubFetch(url);
  if (!response.ok) throw new Error(`GitHub release lookup failed with HTTP ${response.status}`);
  return await response.json() as GithubRelease;
}

export async function resolveHostAssetsRelease(ref: string, channel?: HostAssetsChannel): Promise<HostAssetsRelease> {
  const normalized = normalizeVersion(ref);
  if (normalized && normalized !== 'latest' && normalized !== 'next') {
    const release = await readRelease(`${GITHUB_API}/releases/tags/${encodeURIComponent(normalized)}`);
    return releaseAsset(release, normalized);
  }
  const desired = channel ?? (normalized === 'next' ? 'prerelease' : 'stable');
  const releases: GithubRelease[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await githubFetch(`${GITHUB_API}/releases?per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`GitHub release listing failed with HTTP ${response.status}`);
    const pageReleases = await response.json() as GithubRelease[];
    releases.push(...pageReleases);
    if (pageReleases.length < 100) break;
  }
  const candidates = releases.filter(release => !release.draft && Boolean(release.prerelease) === (desired === 'prerelease'));
  const withAssets = candidates.map(release => {
    try { return releaseAsset(release, releaseVersion(release)); } catch { return null; }
  }).filter((release): release is HostAssetsRelease => release !== null);
  const newest = withAssets.sort((a, b) => compareComparableVersions(b.version, a.version))[0];
  if (!newest) throw new Error(`No ${desired} host-assets release is available`);
  return newest;
}

export async function stageHostAssetsRelease(release: HostAssetsRelease, dataDir: string): Promise<string> {
  const response = await githubFetch(release.assetUrl);
  if (!response.ok) throw new Error(`Host-assets download failed with HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const checksumResponse = await githubFetch(release.checksumUrl);
  if (!checksumResponse.ok) throw new Error(`Host-assets checksum download failed with HTTP ${checksumResponse.status}`);
  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || expected !== actual) throw new Error('Host-assets checksum mismatch');

  const operationId = `${process.pid}-${randomUUID()}`;
  const staging = join(dataDir, `.host-assets.staging-${operationId}`);
  const archive = join(dataDir, `.host-assets-${operationId}.tar.gz.tmp`);
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(archive, bytes);
    await extract({ file: archive, cwd: staging, strict: true });
    const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8')) as Partial<HostAssetsManifest>;
    if (manifest.platformVersion !== release.version || !Number.isSafeInteger(manifest.minHarnessContract) || (manifest.minHarnessContract ?? 0) < 1) throw new Error('Host-assets manifest is invalid or does not match the release');
    if (!existsSync(join(staging, 'ui', 'index.js')) || !existsSync(join(staging, 'skeleton', 'system', 'stack'))) throw new Error('Host-assets bundle is missing ui/ or skeleton/');
    release.manifest = manifest as HostAssetsManifest;
    return staging;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(archive, { force: true });
  }
}

export function restoreHostAssetsBackup(liveDir: string, backupDir: string): void {
  rmSync(liveDir, { recursive: true, force: true });
  if (existsSync(backupDir)) renameSync(backupDir, liveDir);
}

export function hostAssetsChannel(version: string, explicit?: HostAssetsChannel): HostAssetsChannel {
  return explicit ?? (distTagForVersion(version) === 'next' ? 'prerelease' : 'stable');
}

export function hostAssetsError(error: unknown): string { return errMessage(error); }
