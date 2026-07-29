import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SETUP_SH_PATH = join(import.meta.dir, 'setup.sh');
const setupShSource = readFileSync(SETUP_SH_PATH, 'utf8');

function runBash(script: string, arg: string): string {
	const result = Bun.spawnSync({
		cmd: ['bash', '-c', script, 'bash', arg],
		stdout: 'pipe',
		stderr: 'pipe'
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	return result.stdout.toString('utf8');
}

describe('setup.sh latest release-asset resolver', () => {
	it('uses the release manifest redirect instead of the rate-limited API', () => {
		expect(setupShSource).toContain(
			'https://github.com/itlackey/openpalm/releases/latest/download/release-assets-manifest.json'
		);
		expect(setupShSource).not.toContain('api.github.com/repos/itlackey/openpalm/releases/latest');
		expect(setupShSource).toContain("-o /dev/null -w '%{url_effective}'");
	});

	it('uses an exact release manifest for an explicitly requested prerelease', () => {
		expect(setupShSource).toContain(
			'https://github.com/itlackey/openpalm/releases/download/${VERSION}/release-assets-manifest.json'
		);
		expect(setupShSource).toContain(
			'die "Release manifest identifies ${MANIFEST_VERSION}, expected ${VERSION}"'
		);
	});

	const fnMatch = setupShSource.match(/manifest_version\(\) \{[\s\S]*?\n\}/);
	if (!fnMatch) throw new Error('Could not locate manifest_version() in scripts/setup.sh');
	const manifestVersionFn = fnMatch[0];

	function extractVersion(sampleJson: string): string {
		return runBash(
			`${manifestVersionFn}\nprintf '%s\\n' "$1" | manifest_version`,
			sampleJson
		).trim();
	}

	it('extracts stable and prerelease versions from published manifests', () => {
		expect(extractVersion('{"version":"0.12.0","assets":[]}')).toBe('0.12.0');
		expect(extractVersion('{\n  "version": "0.13.0-beta.13"\n}')).toBe('0.13.0-beta.13');
	});

	it('yields an empty string when version is absent so setup fails closed', () => {
		expect(extractVersion('{"assets":[]}')).toBe('');
	});
});

describe('setup.sh normalize_version()', () => {
	const fnMatch = setupShSource.match(/normalize_version\(\) \{[\s\S]*?\n\}/);
	if (!fnMatch) throw new Error('Could not locate normalize_version() in scripts/setup.sh');
	const normalizeVersionFn = fnMatch[0];

	function normalizeVersion(input: string): string {
		return runBash(`${normalizeVersionFn}\nnormalize_version "$1"`, input).trim();
	}

	it('strips a legacy v prefix and preserves bare prerelease versions', () => {
		expect(normalizeVersion('v0.11.0')).toBe('0.11.0');
		expect(normalizeVersion('0.13.0-beta.13')).toBe('0.13.0-beta.13');
	});
});

describe('setup.ps1 latest release-asset resolver', () => {
	const source = readFileSync(join(import.meta.dir, 'setup.ps1'), 'utf8');

	it('uses the same manifest identity contract without the GitHub API', () => {
		expect(source).toContain('releases/latest/download/release-assets-manifest.json');
		expect(source).toContain('releases/download/$Version/release-assets-manifest.json');
		expect(source).toContain('$ManifestVersion -ne $Version');
		expect(source).toContain('$LatestResponse.BaseResponse.ResponseUri.AbsoluteUri');
		expect(source).toContain('$LatestResponse.BaseResponse.RequestMessage.RequestUri.AbsoluteUri');
		expect(source).not.toContain('api.github.com');
	});
});
