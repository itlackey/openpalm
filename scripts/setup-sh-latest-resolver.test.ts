import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SETUP_SH_PATH = join(import.meta.dir, 'setup.sh');
const setupShSource = readFileSync(SETUP_SH_PATH, 'utf8');

// setup.sh runs with `set -euo pipefail` (S1/M6): a pipeline extracted and
// exercised WITHOUT those options can look correct while silently pinning
// behavior the shipped script does not have — an empty-`grep` result that
// exits non-zero, quietly aborting under `set -e` and `pipefail` on the real
// script's failure path, but returning a plain empty string here with no
// hint of the difference. Every snippet below runs under the script's own
// options so a regression back to the S1 bug (a guard removed, `|| true`
// dropped) fails these tests instead of shipping unnoticed.
function runBash(script: string, arg: string): string {
	const result = Bun.spawnSync({
		cmd: ['bash', '-c', `set -euo pipefail\n${script}`, 'bash', arg],
		stdout: 'pipe',
		stderr: 'pipe'
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	return result.stdout.toString('utf8');
}

/** Raw variant for scenarios that are expected to (or might) exit non-zero. */
function runBashRaw(script: string): { exitCode: number | null; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: ['bash', '-c', `set -euo pipefail\n${script}`],
		stdout: 'pipe',
		stderr: 'pipe'
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString('utf8'),
		stderr: result.stderr.toString('utf8')
	};
}

/** Find the first source line containing `marker`, verbatim — ties a test to the REAL shipped line instead of a hand-copied duplicate that can silently drift from it. */
function findLine(source: string, marker: string): string {
	const line = source.split('\n').find((l) => l.includes(marker));
	if (line === undefined) throw new Error(`Could not find a line containing: ${marker}`);
	return line;
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
});

// S1/M6: the two `set -euo pipefail` failure paths in setup.sh whose `die`
// messages were dead code — a `grep|sed`/`grep|awk` pipeline that finds no
// match fails the enclosing assignment, and `set -e` used to exit BEFORE the
// next line's `[ -n "$X" ] || die "..."` guard could ever run (verified by
// repro: exit 1, zero output). These tests extract and run the REAL shipped
// lines (via `findLine`, not a hand-copied stand-in) under the script's own
// shell options, so a regression that drops the `|| true` guard fails here
// instead of shipping silent again.
describe('S1 — manifest/checksum extraction fails closed WITH a visible message', () => {
	const dieFnLine = findLine(setupShSource, 'die()');
	const colorLine = findLine(setupShSource, "RED='\\033[0;31m'");
	const manifestVersionFn = setupShSource.match(/manifest_version\(\) \{[\s\S]*?\n\}/)?.[0];
	if (!manifestVersionFn) throw new Error('Could not locate manifest_version() in scripts/setup.sh');

	const manifestAssignLine = findLine(setupShSource, 'MANIFEST_VERSION="$(printf');
	const manifestDieLine = findLine(setupShSource, 'die "Release manifest does not declare a version"');

	// The sample JSON is spliced directly into the script text (single-quoted;
	// the fixtures below contain no single quotes) rather than threaded in as
	// a positional arg, since each call builds a fresh ad-hoc script.
	function runManifestExtractionInline(sampleJson: string) {
		return runBashRaw(
			[colorLine, dieFnLine, manifestVersionFn, `RELEASE_MANIFEST='${sampleJson}'`, manifestAssignLine, manifestDieLine, `printf '%s\\n' "$MANIFEST_VERSION"`].join(
				'\n'
			)
		);
	}

	it('a manifest with a version extracts it and exits 0 (happy path still works)', () => {
		const result = runManifestExtractionInline('{"version":"0.13.5","assets":[]}');
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('0.13.5');
	});

	it('a manifest with NO version dies loudly (visible message, non-zero exit) instead of exiting silently', () => {
		const result = runManifestExtractionInline('{"assets":[]}');
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('Release manifest does not declare a version');
		// The historical bug: the pipeline failure tripped `set -e` before the
		// `die` line ran, so NOTHING was printed at all.
		expect(result.stderr.length).toBeGreaterThan(0);
	});

	const checksumAssignLine = findLine(setupShSource, 'EXPECTED="$(printf');
	const checksumDieLine = findLine(setupShSource, 'die "No checksum found for');

	function runChecksumExtraction(binary: string, checksums: string) {
		return runBashRaw(
			[colorLine, dieFnLine, `BINARY='${binary}'`, `CHECKSUMS='${checksums}'`, checksumAssignLine, checksumDieLine, `printf '%s\\n' "$EXPECTED"`].join('\n')
		);
	}

	it('an exact checksum match extracts the hash and exits 0', () => {
		const result = runChecksumExtraction(
			'openpalm-cli-linux-x64',
			'deadbeef  openpalm-cli-linux-x64\ncafebabe  openpalm-cli-linux-arm64'
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('deadbeef');
	});

	it('is anchored: a same-prefix asset (e.g. a future .sig) does not cause a multi-line false match', () => {
		const result = runChecksumExtraction(
			'openpalm-cli-linux-x64',
			'deadbeef  openpalm-cli-linux-x64\ncafebabe  openpalm-cli-linux-x64.sig'
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('deadbeef');
	});

	it('a missing checksum dies loudly instead of exiting silently', () => {
		const result = runChecksumExtraction('openpalm-cli-darwin-arm64', 'deadbeef  openpalm-cli-linux-x64');
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('No checksum found for openpalm-cli-darwin-arm64');
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
