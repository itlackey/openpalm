#!/usr/bin/env node
/** GitHub's existing npm trusted publisher; never silently fall back to a token. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemver } from './set-version.mjs';
import { requiredReleaseAssets } from './validate-release-assets.mjs';

export function releaseChannel(version) {
	const parsed = parseSemver(version);
	if (!parsed) throw new Error('Invalid release version');
	if (!parsed.pre) return 'latest';
	return parsed.pre.startsWith('beta.') ? 'beta' : parsed.pre.startsWith('rc.') ? 'rc' : 'next';
}

export async function publishBootstrap({
	version,
	sha,
	env = process.env,
	fetchImpl = fetch,
	run = (args) => execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}) {
	const channel = releaseChannel(version);
	if (
		env.GITHUB_SERVER_URL !== 'https://github.com' ||
		env.GITHUB_REPOSITORY !== 'itlackey/openpalm' ||
		!env.ACTIONS_ID_TOKEN_REQUEST_URL ||
		!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
	)
		throw new Error('npm publication requires GitHub trusted publishing');
	const response = await fetchImpl(
		`https://api.github.com/repos/itlackey/openpalm/releases/tags/${encodeURIComponent(version)}`,
		{ redirect: 'error', headers: { Accept: 'application/vnd.github+json' } }
	);
	if (!response.ok) throw new Error('Public GitHub release is unavailable');
	const release = await response.json();
	if (
		release.draft ||
		release.tag_name !== version ||
		release.target_commitish !== sha ||
		release.prerelease !== (channel !== 'latest') ||
		!Array.isArray(release.assets)
	) {
		throw new Error('GitHub release is not the verified public candidate');
	}
	for (const name of [...requiredReleaseAssets(version), 'release-assets-manifest.json']) {
		if (!release.assets.some((asset) => asset.name === name))
			throw new Error(`Missing public asset: ${name}`);
	}
	const [packed] = JSON.parse(run(['pack', '--json']));
	if (packed.version !== version || !packed.integrity || !packed.filename)
		throw new Error('Packed npm version differs');
	let existing;
	try {
		existing = JSON.parse(run(['view', `openpalm@${version}`, 'dist.integrity', '--json']));
	} catch (error) {
		if (!String(error.stderr ?? '').includes('E404')) throw error;
	}
	if (existing) {
		if (existing !== packed.integrity)
			throw new Error('Existing npm version differs; use a new version');
		return { version, channel, alreadyPublished: true };
	}
	run(['publish', '--provenance', '--access', 'public', '--tag', channel, packed.filename]);
	return { version, channel, alreadyPublished: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = await publishBootstrap({
		version: process.env.VERSION ?? '',
		sha: process.env.GITHUB_SHA ?? ''
	});
	console.log(
		`npm ${result.version}: ${result.alreadyPublished ? 'verified existing package' : `published to ${result.channel}`}`
	);
}
