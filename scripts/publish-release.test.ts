import { describe, expect, test } from 'bun:test';
import { publishBootstrap, releaseChannel } from './publish-bootstrap.mjs';
import { requiredReleaseAssets } from './validate-release-assets.mjs';

const version = '0.14.0-beta.1';
const sha = 'a'.repeat(40);
const names = [...requiredReleaseAssets(version), 'release-assets-manifest.json'];
const env = {
	GITHUB_SERVER_URL: 'https://github.com',
	GITHUB_REPOSITORY: 'itlackey/openpalm',
	ACTIONS_ID_TOKEN_REQUEST_URL: 'issuer',
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token'
};
const release = {
	draft: false,
	tag_name: version,
	target_commitish: sha,
	prerelease: true,
	assets: names.map((name) => ({ name }))
};

describe('GitHub npm trusted publishing', () => {
	test('beta and rc never select the latest npm tag', () => {
		expect(releaseChannel(version)).toBe('beta');
		expect(releaseChannel('0.14.0-rc.1')).toBe('rc');
		expect(releaseChannel('0.14.0-preview.1')).toBe('next');
		expect(releaseChannel('0.14.0-alpha.1')).toBe('next');
		expect(releaseChannel('0.14.0')).toBe('latest');
		expect(() => releaseChannel('invalid')).toThrow();
	});

	test('rejects another host or repository before making any request', async () => {
		for (const override of [
			{ GITHUB_SERVER_URL: 'https://other.example' },
			{ GITHUB_REPOSITORY: 'other/project' },
			{ ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }
		]) {
			let requests = 0;
			await expect(
				publishBootstrap({
					version,
					sha,
					env: { ...env, ...override },
					fetchImpl: async () => {
						requests++;
						return Response.json(release);
					}
				})
			).rejects.toThrow('GitHub');
			expect(requests).toBe(0);
		}
	});

	test('requires the complete public GitHub release for this candidate', async () => {
		for (const candidate of [
			{ ...release, draft: true },
			{ ...release, target_commitish: 'b'.repeat(40) },
			{ ...release, tag_name: '0.13.6' },
			{ ...release, prerelease: false },
			{ ...release, assets: [] }
		]) {
			await expect(
				publishBootstrap({
					version,
					sha,
					env,
					fetchImpl: async (url: string, options: RequestInit) => {
						expect(url).toBe(
							`https://api.github.com/repos/itlackey/openpalm/releases/tags/${version}`
						);
						expect(options.redirect).toBe('error');
						return Response.json(candidate);
					},
					run: () => {
						throw new Error('npm must not run before release verification');
					}
				})
			).rejects.toThrow();
		}
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
			const args = { version, sha, env, fetchImpl: async () => Response.json(release), run };
			if (integrity.endsWith('match'))
				expect((await publishBootstrap(args)).alreadyPublished).toBe(true);
			else await expect(publishBootstrap(args)).rejects.toThrow('differs');
			expect(calls.some((args) => args[0] === 'publish')).toBe(false);
		}
	});

	test('publishes only the verified package to the beta channel when npm returns E404', async () => {
		const calls: string[][] = [];
		await publishBootstrap({
			version,
			sha,
			env,
			fetchImpl: async () => Response.json(release),
			run: (args: string[]) => {
				calls.push(args);
				if (args[0] === 'pack')
					return JSON.stringify([
						{
							version,
							integrity: 'sha512-match',
							filename: 'openpalm.tgz'
						}
					]);
				if (args[0] === 'view') throw Object.assign(new Error('not found'), { stderr: 'E404' });
				return '';
			}
		});
		expect(calls.at(-1)).toEqual([
			'publish',
			'--provenance',
			'--access',
			'public',
			'--tag',
			'beta',
			'openpalm.tgz'
		]);
	});
});
