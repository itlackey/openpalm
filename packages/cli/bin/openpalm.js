#!/usr/bin/env node
// OpenPalm npm bootstrapper.
//
// The published `openpalm` npm package ships ONLY this file (see package.json
// `files`) — it has zero runtime dependencies and must run under plain Node
// (no Bun, no TypeScript). The actual CLI is a Bun-compiled standalone binary
// published as a GitHub release asset (see scripts/setup.sh and
// src/commands/self-update.ts, which resolve/verify/run the same artifacts).
//
// On each invocation this script:
//   1. Maps process.platform/arch to the matching release binary name.
//   2. Resolves this package's own version (must match an existing release tag).
//   3. Downloads + SHA-256-verifies the binary into a per-user cache dir on
//      first use for that version (never in postinstall — see A1 in
//      docs/public-seams-review.md for why).
//   4. Runs the cached binary, inheriting stdio, and propagates its exit code.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GITHUB_REPO = 'itlackey/openpalm';

/**
 * Map a Node `platform`/`arch` pair to the published release binary name.
 * Mirrors the table in scripts/setup.sh (POSIX) plus the Windows x64 artifact
 * published by release.yml. Throws clearly for anything unpublished.
 */
export function resolveArtifactName(platform = process.platform, arch = process.arch) {
	if (platform === 'linux' && arch === 'x64') return 'openpalm-cli-linux-x64';
	if (platform === 'linux' && arch === 'arm64') return 'openpalm-cli-linux-arm64';
	if (platform === 'darwin' && arch === 'x64') return 'openpalm-cli-darwin-x64';
	if (platform === 'darwin' && arch === 'arm64') return 'openpalm-cli-darwin-arm64';
	if (platform === 'win32' && arch === 'x64') return 'openpalm-cli-windows-x64.exe';
	if (platform === 'win32' && arch === 'arm64') return 'openpalm-cli-windows-arm64.exe';
	throw new Error(
		`Unsupported platform: ${platform}/${arch}. OpenPalm does not publish a prebuilt CLI binary ` +
			`for this platform yet. See https://github.com/${GITHUB_REPO}#installation for supported platforms.`
	);
}

/**
 * Resolve this package's own version from package.json. The package is ESM
 * (`"type": "module"`), so a plain `require()` is unavailable — this must use
 * `createRequire(import.meta.url)` (a bare `import ... with { type: 'json' }`
 * would work too, but createRequire keeps this file runnable on older Node 18/20).
 */
export function resolvePackageVersion(requireFn = createRequire(import.meta.url)) {
	return requireFn('../package.json').version;
}

/** Resolve a per-user cache directory root. `env.OPENPALM_CACHE_DIR` always wins (tests/ops). */
export function resolveCacheRoot(env = process.env, platform = process.platform, home = homedir()) {
	if (env.OPENPALM_CACHE_DIR) return env.OPENPALM_CACHE_DIR;
	if (platform === 'darwin') return join(home, 'Library', 'Caches', 'openpalm');
	if (platform === 'win32') {
		return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'openpalm', 'Cache');
	}
	return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'openpalm');
}

/**
 * Parse the expected SHA-256 for `artifact` out of a checksums-sha256.txt body.
 * Mirrors the `grep "${BINARY}" | awk '{print $1}'` pass in scripts/setup.sh.
 */
export function parseExpectedChecksum(checksums, artifact) {
	const line = checksums
		.split('\n')
		.map((entry) => entry.trim())
		.find((entry) => entry.endsWith(` ${artifact}`) || entry.endsWith(`  ${artifact}`));
	if (!line) throw new Error(`No published checksum found for ${artifact}.`);
	const checksum = line.split(/\s+/)[0]?.trim();
	if (!checksum) throw new Error(`Published checksum entry for ${artifact} is invalid.`);
	return checksum;
}

function sha256Hex(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Ensure the versioned release binary is present and checksum-verified in the
 * cache dir, downloading it on a cache miss. Returns the absolute path to the
 * cached, executable binary. `fetchImpl` and the fs primitives are injectable
 * so tests can stub network + disk I/O without touching the real filesystem
 * or network.
 */
export async function ensureCachedBinary({
	version,
	artifact,
	cacheRoot,
	fetchImpl = fetch,
	fs = { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, chmodSync }
}) {
	const versionDir = join(cacheRoot, 'bin', version);
	const finalPath = join(versionDir, artifact);
	if (fs.existsSync(finalPath)) return finalPath;

	fs.mkdirSync(versionDir, { recursive: true });

	const binaryUrl = `https://github.com/${GITHUB_REPO}/releases/download/${version}/${artifact}`;
	const checksumUrl = `https://github.com/${GITHUB_REPO}/releases/download/${version}/checksums-sha256.txt`;

	const [binaryRes, checksumRes] = await Promise.all([
		fetchImpl(binaryUrl, { signal: AbortSignal.timeout(120_000) }),
		fetchImpl(checksumUrl, { signal: AbortSignal.timeout(30_000) })
	]);
	if (!binaryRes.ok) throw new Error(`Failed to download ${artifact} (${binaryRes.status}).`);
	if (!checksumRes.ok)
		throw new Error(`Failed to download release checksums (${checksumRes.status}).`);

	const binaryBytes = new Uint8Array(await binaryRes.arrayBuffer());
	const expected = parseExpectedChecksum(await checksumRes.text(), artifact);
	const actual = sha256Hex(binaryBytes);
	if (actual !== expected) {
		throw new Error(`Checksum mismatch for ${artifact}: expected ${expected}, got ${actual}.`);
	}

	const tempPath = `${finalPath}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tempPath, binaryBytes);
		fs.chmodSync(tempPath, 0o755);
		fs.renameSync(tempPath, finalPath);
	} catch (err) {
		fs.rmSync(tempPath, { force: true });
		throw err;
	}
	return finalPath;
}

/** Run the cached binary, inheriting stdio, and return its exit code. */
export function runBinary(binaryPath, args = process.argv.slice(2), spawn = spawnSync) {
	const result = spawn(binaryPath, args, { stdio: 'inherit' });
	if (result.error) throw result.error;
	if (typeof result.status === 'number') return result.status;
	return result.signal ? 1 : 0;
}

export async function main() {
	const artifact = resolveArtifactName();
	const version = resolvePackageVersion();
	const cacheRoot = resolveCacheRoot();
	const binaryPath = await ensureCachedBinary({ version, artifact, cacheRoot });
	return runBinary(binaryPath);
}

const isMainModule = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMainModule) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(`openpalm: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
