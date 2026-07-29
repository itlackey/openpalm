/** Host UI and skeleton resolution and the 0.13 GitHub host-assets updater. */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareComparableVersions, isSameMajorVersion, normalizeVersion } from './versioning.js';
import { resolveDataDir, resolveBackupsDir } from './home.js';
import { overwriteSystemTree } from './core-assets.js';
import { createLogger } from '../logger.js';
import { hostAssetsChannel, resolveHostAssetsRelease, stageHostAssetsRelease, type HostAssetsChannel } from './host-assets-updater.js';
import { pruneBackupNamespace } from './backup.js';

const logger = createLogger('lib:ui-assets');
const HOST_ASSET_BACKUPS_KEPT = 3;
export const UI_VERSION_STAMP = '.openpalm-ui-version';
export const SKELETON_VERSION_STAMP = '.skeleton-version';
export type UiUpdateChannel = HostAssetsChannel | 'latest' | 'next';

function toHostChannel(channel: UiUpdateChannel | undefined): HostAssetsChannel | undefined {
  if (channel === 'latest' || channel === 'stable') return 'stable';
  if (channel === 'next' || channel === 'prerelease') return 'prerelease';
  return undefined;
}

function pruneHostAssetBackups(homeDir: string, namespace: 'ui' | 'skeleton'): void {
  try {
    pruneBackupNamespace(homeDir, namespace, HOST_ASSET_BACKUPS_KEPT);
  } catch (error) {
    logger.warn(`failed to prune ${namespace} backups`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function localCandidate(...strategies: Array<() => string | null>): string | null {
  for (const strategy of strategies) {
    try { const candidate = strategy(); if (candidate && existsSync(candidate)) return candidate; } catch { /* optional source */ }
  }
  return null;
}

function copyTree(source: string, destination: string, skipExisting = false): void {
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? (entry as unknown as { path: string }).path;
    const sourceFile = join(parent, entry.name);
    const target = join(destination, relative(source, sourceFile));
    if (skipExisting && existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(sourceFile, target);
  }
}

export function resolveLocalOpenpalmDir(): string | null {
  return localCandidate(
    () => process.env.OPENPALM_REPO_ROOT ? join(process.env.OPENPALM_REPO_ROOT, 'packages', 'skeleton') : null,
    () => process.env.OPENPALM_SKELETON_DIR ?? null,
    () => join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'skeleton'),
  );
}

export function resolveLocalUiBuild(): string | null {
  return localCandidate(
    () => process.env.OPENPALM_REPO_ROOT ? join(process.env.OPENPALM_REPO_ROOT, 'packages', 'ui', 'build') : null,
    () => { const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath; return resources ? join(resources, 'ui-build') : null; },
    () => { const meta = fileURLToPath(import.meta.url); return meta.startsWith('/$bunfs/') ? null : join(dirname(meta), '..', '..', '..', '..', 'packages', 'ui', 'build'); },
  );
}

export function readUiBuildVersion(dir: string): string | null {
  try { return readFileSync(join(dir, UI_VERSION_STAMP), 'utf8').trim() || null; } catch { return null; }
}
export function readSkeletonVersion(homeDir: string): string | null {
  try { return readFileSync(join(homeDir, SKELETON_VERSION_STAMP), 'utf8').trim() || null; } catch { return null; }
}
function writeSkeletonVersion(homeDir: string, version: string): void { writeFileSync(join(homeDir, SKELETON_VERSION_STAMP), `${version}\n`); }

export async function applyHomeSeed(_repoRef: string, homeDir: string, _configDir: string, dataDir: string): Promise<{ updated: string[]; backupDir: string | null }> {
  let source = resolveLocalOpenpalmDir();
  let staged: string | null = null;
  if (!source) {
    const release = await resolveHostAssetsRelease(normalizeVersion(_repoRef));
    staged = await stageHostAssetsRelease(release, dataDir);
    source = join(staged, 'skeleton');
  }
  try {
    const managed = overwriteSystemTree(source, homeDir);
    copyTree(source, homeDir, true);
    try {
      const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
      if (typeof version === 'string') writeSkeletonVersion(homeDir, normalizeVersion(version));
    } catch { /* source bundles carry the release manifest, not necessarily package.json */ }
    if (!readSkeletonVersion(homeDir) && staged) writeSkeletonVersion(homeDir, normalizeVersion(_repoRef));
    return managed;
  } finally { if (staged) rmSync(staged, { recursive: true, force: true }); }
}

export function resolveUiBuildDir(): string {
  const data = join(resolveDataDir(), 'ui');
  const bundled = resolveLocalUiBuild();
  if (existsSync(join(data, 'index.js')) && bundled && existsSync(join(bundled, 'index.js'))) {
    const dataVersion = readUiBuildVersion(data);
    const bundledVersion = readUiBuildVersion(bundled);
    if (dataVersion && bundledVersion && compareComparableVersions(dataVersion, bundledVersion) > 0) return data;
    logger.warn('data/ui is not newer than the bundled UI; using bundled build', { data, bundled, dataVersion, bundledVersion });
    return bundled;
  }
  if (existsSync(join(data, 'index.js'))) return data;
  if (bundled && existsSync(join(bundled, 'index.js'))) return bundled;
  return data;
}

export function declaredUiChannel(): UiUpdateChannel | null {
  const value = (process.env.OP_UI_CHANNEL ?? '').trim().toLowerCase();
  return value === 'stable' || value === 'prerelease' || value === 'latest' || value === 'next' ? value : null;
}
export function uiUpdateChannel(version: string, channel?: UiUpdateChannel): UiUpdateChannel {
  return channel ?? declaredUiChannel() ?? hostAssetsChannel(version);
}

async function stageUi(version: string, dataDir: string, channel?: UiUpdateChannel): Promise<{ staging: string; manifest: { platformVersion: string; minHarnessContract: number } }> {
  const release = await resolveHostAssetsRelease(version, toHostChannel(channel));
  const staging = await stageHostAssetsRelease(release, dataDir);
  return { staging, manifest: release.manifest };
}

export async function seedUiBuild(version: string, dataDir: string, options?: { forceRemote?: boolean }, harnessContract?: number | null): Promise<void> {
  const local = options?.forceRemote ? null : resolveLocalUiBuild();
  const uiDir = join(dataDir, 'ui');
  if (local) { mkdirSync(uiDir, { recursive: true }); copyTree(local, uiDir); return; }
  const { staging, manifest } = await stageUi(normalizeVersion(version), dataDir, uiUpdateChannel(version));
  try {
    if (typeof harnessContract === 'number' && manifest.minHarnessContract > harnessContract) throw new Error(`host-assets ${manifest.platformVersion} requires harness contract v${manifest.minHarnessContract}`);
    rmSync(uiDir, { recursive: true, force: true });
    renameSync(join(staging, 'ui'), uiDir);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export interface UiBuildUpdateResult { updated: boolean; latestVersion: string | null; error?: string; redownloadRequired?: boolean; requiredHarnessContract?: number; backupDir?: string; }
export async function checkAndUpdateUiBuild(platformVersion: string, dataDir: string, channel?: UiUpdateChannel, harnessContract?: number | null): Promise<UiBuildUpdateResult> {
  const uiDir = join(dataDir, 'ui');
  let backup: string | undefined;
  try {
    const selectedChannel = uiUpdateChannel(platformVersion, channel);
    const { staging, manifest } = await stageUi(toHostChannel(selectedChannel) === 'prerelease' ? 'next' : 'latest', dataDir, selectedChannel);
    if (typeof harnessContract === 'number' && manifest.minHarnessContract > harnessContract) {
      rmSync(staging, { recursive: true, force: true });
      return { updated: false, latestVersion: manifest.platformVersion, redownloadRequired: true, requiredHarnessContract: manifest.minHarnessContract };
    }
    const current = readUiBuildVersion(resolveUiBuildDir());
    if (!isSameMajorVersion(manifest.platformVersion, current ?? platformVersion)) { rmSync(staging, { recursive: true, force: true }); return { updated: false, latestVersion: manifest.platformVersion }; }
    if (current && compareComparableVersions(manifest.platformVersion, current) <= 0) { rmSync(staging, { recursive: true, force: true }); return { updated: false, latestVersion: manifest.platformVersion }; }
    if (existsSync(uiDir)) { backup = join(resolveBackupsDir(), `ui-${Date.now()}`); mkdirSync(resolveBackupsDir(), { recursive: true }); renameSync(uiDir, backup); }
    renameSync(join(staging, 'ui'), uiDir);
    writeFileSync(join(uiDir, UI_VERSION_STAMP), `${manifest.platformVersion}\n`);
    rmSync(staging, { recursive: true, force: true });
    if (backup) pruneHostAssetBackups(dirname(dataDir), 'ui');
    return { updated: true, latestVersion: manifest.platformVersion, backupDir: backup };
  } catch (error) {
    if (backup && !existsSync(uiDir)) renameSync(backup, uiDir);
    return { updated: false, latestVersion: null, error: error instanceof Error ? error.message : String(error), backupDir: backup };
  }
}

export interface SkeletonUpdateResult { updated: boolean; latestVersion: string | null; error?: string; }
export async function checkAndUpdateSkeleton(platformVersion: string, homeDir: string, dataDir: string, channel?: UiUpdateChannel): Promise<SkeletonUpdateResult> {
  const systemDir = join(homeDir, 'system');
  const hadSystem = existsSync(systemDir);
  let backup: string | undefined;
  let staging: string | undefined;
  let current: string | null = null;
  try {
    const selectedChannel = uiUpdateChannel(platformVersion, channel);
    const release = await resolveHostAssetsRelease(toHostChannel(selectedChannel) === 'prerelease' ? 'next' : 'latest', toHostChannel(selectedChannel));
    staging = await stageHostAssetsRelease(release, dataDir);
    current = readSkeletonVersion(homeDir);
    if (!isSameMajorVersion(release.manifest.platformVersion, current ?? platformVersion)) return { updated: false, latestVersion: release.manifest.platformVersion };
    if (current && compareComparableVersions(release.manifest.platformVersion, current) <= 0) return { updated: false, latestVersion: release.manifest.platformVersion };
    if (existsSync(systemDir)) { backup = join(resolveBackupsDir(), `skeleton-${Date.now()}`); mkdirSync(resolveBackupsDir(), { recursive: true }); renameSync(systemDir, backup); }
    renameSync(join(staging, 'skeleton', 'system'), systemDir);
    writeSkeletonVersion(homeDir, release.manifest.platformVersion);
    if (backup) pruneHostAssetBackups(homeDir, 'skeleton');
    return { updated: true, latestVersion: release.manifest.platformVersion };
  } catch (error) {
    if (backup) {
      rmSync(systemDir, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, systemDir);
    } else if (!hadSystem) rmSync(systemDir, { recursive: true, force: true });
    if (readSkeletonVersion(homeDir) !== current) {
      if (current) writeSkeletonVersion(homeDir, current);
      else rmSync(join(homeDir, SKELETON_VERSION_STAMP), { force: true });
    }
    return { updated: false, latestVersion: null, error: error instanceof Error ? error.message : String(error) };
  } finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
}
