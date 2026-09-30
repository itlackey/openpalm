import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	publishRelease,
	releaseChannel,
	RELEASE_ORIGIN,
	RELEASE_REPOSITORY,
	validateDestination
} from './publish-gitea-release.mjs';
import { publishBootstrap } from './publish-bootstrap.mjs';
import { requiredReleaseAssets, writeReleaseAssetManifest } from './validate-release-assets.mjs';

const version = '0.14.0-beta.1';
const sha = 'a'.repeat(40);
const names = [...requiredReleaseAssets(version), 'release-assets-manifest.json'];

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'openpalm-release-'));
	const checksums = [];
	for (const name of requiredReleaseAssets(version)) {
		if (name === 'checksums-sha256.txt') continue;
		writeFileSync(join(dir, name), name);
		checksums.push(`${createHash('sha256').update(name).digest('hex')}  ${name}`);
	}
	writeFileSync(join(dir, 'checksums-sha256.txt'), `${checksums.join('\n')}\n`);
	writeReleaseAssetManifest(dir, version);
	return dir;
}

describe('canonical staged release', () => {
	test('rejects another destination before any authenticated request', async () => {
		let calls = 0;
		await expect(
			publishRelease({
				dir: '/nonexistent',
				version,
				sha,
				token: 'private',
				origin: 'https://github.com',
				fetchImpl: async () => {
					calls++;
					return new Response();
				}
			})
		).rejects.toThrow('canonical');
		expect(calls).toBe(0);
		expect(() => validateDestination(RELEASE_ORIGIN, 'other/project')).toThrow();
	});

	test('beta and rc never select the latest npm tag', () => {
		expect(releaseChannel(version)).toBe('beta');
		expect(releaseChannel('0.14.0-rc.1')).toBe('rc');
		expect(releaseChannel('0.14.0')).toBe('latest');
	});

	for (const corrupt of [false, true])
		test(
			corrupt
				? 'corrupt upload leaves draft unpublished'
				: 'verifies every upload before publish and retries without mutation',
			async () => {
				const dir = fixture();
				let release: { id: number; target_commitish: string; draft: boolean } | null = null;
				const assets: Array<{ name: string; browser_download_url: string }> = [];
				let mutations = 0;
				let downloads = 0;
				const fetchImpl = async (url: string, options: RequestInit) => {
					expect(options.redirect).toBe('error');
					if (url.includes('/releases/download/')) {
						downloads++;
						const name = decodeURIComponent(url.split('/').at(-1) ?? '');
						return new Response(corrupt ? 'corrupt' : readFileSync(join(dir, name)));
					}
					if (url.includes('/releases/tags/'))
						return release ? Response.json(release) : new Response(null, { status: 404 });
					if (options.method === 'POST' && url.endsWith('/releases')) {
						mutations++;
						const payload = JSON.parse(String(options.body));
						expect(payload.draft).toBe(true);
						expect(payload.prerelease).toBe(true);
						release = { id: 42, target_commitish: sha, draft: true };
						return Response.json(release);
					}
					if (options.method === 'POST') {
						mutations++;
						const name = new URL(url).searchParams.get('name') ?? '';
						const asset = {
							name,
							browser_download_url: `${RELEASE_ORIGIN}/${RELEASE_REPOSITORY}/releases/download/${version}/${encodeURIComponent(name)}`
						};
						assets.push(asset);
						return Response.json(asset);
					}
					if (options.method === 'PATCH') {
						mutations++;
						expect(downloads).toBe(names.length);
						if (!release) throw new Error('Missing release fixture');
						release.draft = false;
						return Response.json(release);
					}
					return Response.json(assets);
				};
				try {
					const args = { dir, version, sha, token: 'private', fetchImpl };
					if (corrupt) {
						await expect(publishRelease(args)).rejects.toThrow('differs');
						expect(release?.draft).toBe(true);
					} else {
						await publishRelease(args);
						const before = mutations;
						await publishRelease(args);
						expect(mutations).toBe(before);
						expect(downloads).toBe(names.length * 2);
					}
				} finally {
					rmSync(dir, { recursive: true });
				}
			}
		);
});

describe('npm trusted publishing', () => {
	const env = {
		GITHUB_SERVER_URL: 'https://github.com',
		GITHUB_REPOSITORY: 'itlackey/openpalm',
		ACTIONS_ID_TOKEN_REQUEST_URL: 'issuer',
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private'
	};
	const fetchImpl = async () =>
		Response.json({ draft: false, target_commitish: sha, assets: names.map((name) => ({ name })) });
	test('rejects a Gitea runner rather than silently switching authentication', async () => {
		await expect(
			publishBootstrap({ version, sha, env: { ...env, GITHUB_SERVER_URL: RELEASE_ORIGIN } })
		).rejects.toThrow('GitHub');
	});
	test('an existing matching npm version is a no-write retry; conflicting bytes fail', async () => {
		for (const integrity of ['sha512-match', 'sha512-other']) {
			const calls: string[][] = [];
			const run = (args: string[]) => {
				calls.push(args);
				return args[0] === 'pack'
					? JSON.stringify([{ version, integrity: 'sha512-match', filename: 'openpalm.tgz' }])
					: JSON.stringify(integrity);
			};
			if (integrity.endsWith('match'))
				expect(
					(await publishBootstrap({ version, sha, env, fetchImpl, run })).alreadyPublished
				).toBe(true);
			else
				await expect(publishBootstrap({ version, sha, env, fetchImpl, run })).rejects.toThrow(
					'differs'
				);
			expect(calls.some((args) => args[0] === 'publish')).toBe(false);
		}
	});
});
