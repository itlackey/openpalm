#!/usr/bin/env node
/** Validate the complete, updater-free OpenPalm 0.14 release asset set. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_BUILDER_YML = join(REPO_ROOT, 'packages/electron/electron-builder.yml');

export const CLI_BINARIES = [
	'openpalm-cli-linux-x64',
	'openpalm-cli-linux-arm64',
	'openpalm-cli-darwin-x64',
	'openpalm-cli-darwin-arm64',
	'openpalm-cli-windows-x64.exe'
];

const ADMIN_TARGETS = [
	{ platform: 'mac', arch: 'arm64', extension: 'zip' },
	{ platform: 'mac', arch: 'x64', extension: 'zip' },
	{ platform: 'linux', arch: 'x64', extension: 'AppImage' },
	{ platform: 'linux', arch: 'arm64', extension: 'AppImage' },
	{ platform: 'windows', arch: 'x64', extension: 'exe' }
];

export function readElectronProductName(path = ELECTRON_BUILDER_YML) {
	const text = readFileSync(path, 'utf8');
	const match = /^productName:\s*(.+?)\s*$/m.exec(text);
	if (!match) throw new Error(`Could not find productName in ${path}`);
	const value = match[1].trim();
	return value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
}

function productSlug(productName) {
	const slug = productName
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!slug) throw new Error('Electron productName does not produce a safe artifact prefix');
	return slug;
}

export function adminAssetName(productName, version, { platform, arch, extension }) {
	const prefix = productSlug(productName);
	if (platform === 'windows') return `${prefix}-Setup-${version}.${extension}`;
	const artifactArch = platform === 'linux' && arch === 'x64' ? 'x86_64' : arch;
	return `${prefix}-${version}-${artifactArch}-${platform}.${extension}`;
}

export function expectedAdminAssets(version, productName = readElectronProductName()) {
	return ADMIN_TARGETS.map((target) => adminAssetName(productName, version, target));
}

export function expectedClaudeExtensionAsset(version) {
	return `openpalm-claude-desktop-${version}.mcpb`;
}

export function requiredReleaseAssets(version, productName = readElectronProductName()) {
	return [
		...CLI_BINARIES,
		...expectedAdminAssets(version, productName),
		expectedClaudeExtensionAsset(version),
		'checksums-sha256.txt'
	];
}

export function checksumFor(checksumsText, filename) {
	for (const rawLine of checksumsText.split('\n')) {
		const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(rawLine.trimEnd());
		if (match?.[2] === filename) return match[1];
	}
	return undefined;
}

export function writeReleaseAssetManifest(dir, version, productName = readElectronProductName()) {
	const manifest = {
		version,
		product: productName,
		assets: [...requiredReleaseAssets(version, productName)].sort()
	};
	writeFileSync(
		join(dir, 'release-assets-manifest.json'),
		`${JSON.stringify(manifest, null, 2)}\n`,
		{ mode: 0o644 }
	);
	return manifest;
}

export function validateReleaseAssets(dir, version, productName = readElectronProductName()) {
	const problems = [];
	const manifestPath = join(dir, 'release-assets-manifest.json');
	if (!existsSync(manifestPath)) return [`Missing ${manifestPath}`];

	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		return [
			`Invalid release asset manifest: ${error instanceof Error ? error.message : String(error)}`
		];
	}
	if (
		manifest.version !== version ||
		manifest.product !== productName ||
		!Array.isArray(manifest.assets) ||
		!manifest.assets.every((item) => typeof item === 'string')
	) {
		problems.push('Release asset manifest has the wrong version, product, or asset list');
	}

	const required = requiredReleaseAssets(version, productName);
	const assets = new Set(Array.isArray(manifest.assets) ? manifest.assets : []);
	if (assets.size !== (Array.isArray(manifest.assets) ? manifest.assets.length : 0)) {
		problems.push('Release asset manifest contains duplicate filenames');
	}
	for (const name of required) {
		if (!assets.has(name) || !existsSync(join(dir, name))) {
			problems.push(`Missing release asset: ${name}`);
		}
	}
	for (const name of assets) {
		if (!required.includes(name)) problems.push(`Unexpected release asset in manifest: ${name}`);
	}

	const checksumsPath = join(dir, 'checksums-sha256.txt');
	if (!existsSync(checksumsPath)) return [...problems, 'Missing checksums-sha256.txt'];
	const checksums = readFileSync(checksumsPath, 'utf8');
	for (const name of required) {
		if (name === 'checksums-sha256.txt' || !existsSync(join(dir, name))) continue;
		const expected = checksumFor(checksums, name);
		if (!expected) {
			problems.push(`Missing checksum for ${name}`);
			continue;
		}
		const actual = createHash('sha256')
			.update(readFileSync(join(dir, name)))
			.digest('hex');
		if (actual !== expected) problems.push(`Checksum mismatch for ${name}`);
	}
	return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dir = resolve(process.env.RELEASE_ASSETS_DIR ?? 'dist');
	const version = process.env.VERSION;
	if (!version) throw new Error('VERSION is required');
	if (process.argv.includes('--write-manifest')) writeReleaseAssetManifest(dir, version);
	const problems = validateReleaseAssets(dir, version);
	if (problems.length > 0) {
		console.error(`Release asset set for ${version} is incomplete:`);
		for (const problem of problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	console.log(
		`Validated ${requiredReleaseAssets(version).length} required release assets for ${version}`
	);
}
