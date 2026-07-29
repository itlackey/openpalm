#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.ASSET_DIR ?? 'dist';
const version = process.env.VERSION;
if (!version) throw new Error('VERSION is required');

const required = [
  'openpalm-cli-linux-x64',
  'openpalm-cli-linux-arm64',
  'openpalm-cli-darwin-x64',
  'openpalm-cli-darwin-arm64',
  'openpalm-cli-windows-x64.exe',
  `openpalm-host-assets-${version}.tar.gz`,
  'checksums-sha256.txt',
];

const manifestPath = join(dir, 'release-assets-manifest.json');
if (!existsSync(manifestPath)) throw new Error(`Missing ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.version !== version || !Array.isArray(manifest.assets)) {
  throw new Error('Release asset manifest has the wrong version or asset list');
}

const assets = new Set(manifest.assets);
for (const name of required) {
  if (!assets.has(name) || !existsSync(join(dir, name))) throw new Error(`Missing release asset: ${name}`);
}

const checksums = readFileSync(join(dir, 'checksums-sha256.txt'), 'utf8');
for (const name of required.filter((entry) => entry !== 'checksums-sha256.txt')) {
  const expected = checksums
    .split('\n')
    .map((line) => line.trim().split(/\s+/, 2))
    .find(([, listed]) => listed === name)?.[0];
  if (!expected) throw new Error(`Missing checksum for ${name}`);
  const actual = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${name}`);
}

console.log(`Validated ${manifest.assets.length} release assets for ${version}`);
