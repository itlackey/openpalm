#!/usr/bin/env node
/** Publish only a complete, verified candidate to the canonical release host. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemver } from './set-version.mjs';
import { requiredReleaseAssets, validateReleaseAssets } from './validate-release-assets.mjs';

export const RELEASE_ORIGIN = 'https://code.lab.fwdslsh.dev';
export const RELEASE_REPOSITORY = 'founder3/openpalm';

export function validateDestination(origin, repository) {
	if (origin !== RELEASE_ORIGIN || repository !== RELEASE_REPOSITORY) {
		throw new Error('Refusing publication outside the canonical OpenPalm Gitea repository');
	}
}

export function releaseChannel(version) {
	const parsed = parseSemver(version);
	if (!parsed) throw new Error('Invalid release version');
	if (!parsed.pre) return 'latest';
	return parsed.pre.startsWith('beta.') ? 'beta' : parsed.pre.startsWith('rc.') ? 'rc' : 'next';
}

export async function publishRelease({
	dir,
	version,
	sha,
	token,
	origin = RELEASE_ORIGIN,
	repository = RELEASE_REPOSITORY,
	fetchImpl = fetch
}) {
	validateDestination(origin, repository);
	releaseChannel(version);
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('RELEASE_SHA must be an exact commit SHA');
	if (!token) throw new Error('GITEA_TOKEN is required');
	const problems = validateReleaseAssets(dir, version);
	if (problems.length) throw new Error(`Invalid release assets: ${problems.join('; ')}`);
	const base = `${origin}/api/v1/repos/${repository}`;
	async function request(url, options = {}, allow404 = false) {
		const response = await fetchImpl(url, {
			...options,
			redirect: 'error',
			headers: {
				Authorization: `token ${token}`,
				...options.headers
			}
		});
		if (allow404 && response.status === 404) return null;
		if (!response.ok) throw new Error(`Gitea request failed (${response.status})`);
		return response;
	}
	const found = await request(`${base}/releases/tags/${encodeURIComponent(version)}`, {}, true);
	let release = found ? await found.json() : null;
	if (release && release.target_commitish !== sha) {
		throw new Error('Existing release belongs to another commit; use a new version');
	}
	if (!release) {
		const response = await request(`${base}/releases`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tag_name: version,
				target_commitish: sha,
				name: `OpenPalm ${version}`,
				body: `OpenPalm ${version}. Fresh install required for 0.14: ${origin}/${repository}/src/tag/${version}/docs/operations/migration-to-0.14.md. Verify downloads with checksums-sha256.txt.`,
				draft: true,
				prerelease: releaseChannel(version) !== 'latest'
			})
		});
		release = await response.json();
	}
	if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error('Invalid release ID');
	const endpoint = `${base}/releases/${release.id}`;
	const expected = [...requiredReleaseAssets(version), 'release-assets-manifest.json'].sort();
	const assets = await (await request(`${endpoint}/assets?limit=100`)).json();
	if (
		!Array.isArray(assets) ||
		assets.some((asset) => !expected.includes(asset.name)) ||
		new Set(assets.map((asset) => asset.name)).size !== assets.length
	) {
		throw new Error('Existing release has unexpected or duplicate assets');
	}
	async function verify(asset, bytes) {
		const url = new URL(asset.browser_download_url);
		if (url.origin !== origin || !url.pathname.startsWith(`/${repository}/releases/download/`)) {
			throw new Error('Asset download URL is not canonical');
		}
		const remote = await (await request(url.href)).arrayBuffer();
		const digest = (data) => createHash('sha256').update(data).digest('hex');
		if (digest(Buffer.from(remote)) !== digest(bytes)) {
			throw new Error(`Published asset differs: ${asset.name}; use a new version`);
		}
	}
	for (const name of expected) {
		const bytes = readFileSync(join(dir, name));
		const existing = assets.find((asset) => asset.name === name);
		if (existing) {
			await verify(existing, bytes);
			continue;
		}
		if (!release.draft) throw new Error('Published release is incomplete; refusing to mutate it');
		const form = new FormData();
		form.append('attachment', new Blob([bytes]), name);
		const uploaded = await (
			await request(`${endpoint}/assets?name=${encodeURIComponent(name)}`, {
				method: 'POST',
				body: form
			})
		).json();
		await verify(uploaded, bytes);
	}
	if (release.draft) {
		await request(endpoint, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ draft: false })
		});
	}
	return { version, id: release.id, url: `${origin}/${repository}/releases/tag/${version}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = await publishRelease({
		dir: resolve(process.env.RELEASE_ASSETS_DIR ?? 'dist'),
		version: process.env.VERSION ?? '',
		sha: process.env.RELEASE_SHA ?? '',
		token: process.env.GITEA_TOKEN ?? '',
		origin: process.env.GITEA_SERVER_URL ?? RELEASE_ORIGIN,
		repository: process.env.GITEA_REPOSITORY ?? RELEASE_REPOSITORY
	});
	console.log(`Verified release ${result.url}`);
}
