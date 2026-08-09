import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SETUP_SH_PATH = join(import.meta.dir, 'setup.sh');
const setupShSource = readFileSync(SETUP_SH_PATH, 'utf8');

// The two `powershellIt` tests below each spawn FOUR PowerShell processes in
// sequence (two executables — pwsh and Windows PowerShell — times two cases),
// and on the Windows runner a cold spawn costs on the order of a second. Under
// bun's default 5s per-test budget that lands right on the boundary: one
// observed CI run passed the ErrorActionPreference test at 4314ms while another
// timed out the sibling test on the same commit, alternating which one failed.
// The default was never a deliberate performance guard — no timeout was set in
// this file at all — so raising it for exactly the process-spawning tests fixes
// the flake without loosening any assertion. Wall-clock cost is unchanged on a
// healthy runner; this only stops a slow one from being reported as a failure.
const POWERSHELL_SPAWN_TIMEOUT_MS = 60_000;

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

	it('retries the manifest fetch and warns visibly when the identity check is skipped fail-open (R1)', () => {
		expect(setupShSource).toContain('curl -fsSL --retry 3 --retry-delay 3 "${MANIFEST_URL}"');
		expect(setupShSource).toContain('skipping the release-manifest identity check');
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

	it('fetches the manifest with retries and warns when skipping the identity check for an explicit -Version (R2)', () => {
		expect(source).toContain('Invoke-WebRequestWithRetry -Uri $ManifestUrl -OutFile $ManifestTempFile');
		expect(source).toContain('Skipping the release-manifest identity check');
	});
});

describe('setup.ps1 CLI install failure propagation', () => {
	const source = readFileSync(join(import.meta.dir, 'setup.ps1'), 'utf8');
	const invocationMarker = '& $Dest install --version $Version @PassthroughArgs';
	const invocationIndex = source.indexOf(invocationMarker);
	if (invocationIndex < 0) throw new Error('Could not locate the setup.ps1 CLI invocation');
	const outerFinallyIndex = source.lastIndexOf('} finally {');
	if (outerFinallyIndex < invocationIndex) throw new Error('Could not locate setup.ps1 outer finally');
	const installFooter = source.slice(invocationIndex, outerFinallyIndex);

	it('uses a terminating PowerShell error rather than exit, while preserving cli-only return', () => {
		const executableLines = source
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		expect(executableLines).not.toMatch(/^\s*exit\b/m);
		expect(installFooter).toContain('$InstallExitCode = $LASTEXITCODE');
		expect(installFooter).toContain('if ($InstallExitCode -ne 0)');
		expect(installFooter).toContain('throw "openpalm install failed with exit code $InstallExitCode"');

		const cliOnlyReturn = source.indexOf('if ($CliOnly) {');
		expect(cliOnlyReturn).toBeGreaterThan(-1);
		expect(source.indexOf('return', cliOnlyReturn)).toBeLessThan(invocationIndex);
	});

	const pwsh = Bun.which('pwsh');
	const windowsPowerShell = process.platform === 'win32' ? Bun.which('powershell') : null;
	const powershellExecutables = [...new Set([pwsh, windowsPowerShell].filter((value) => value !== null))];
	const powershellIt = powershellExecutables.length > 0 ? it : it.skip;

	it('requires the configured PowerShell runtimes when the CI contract is enabled', () => {
		if (process.env.OPENPALM_REQUIRE_PWSH_TESTS === '1') {
			expect(pwsh, 'OPENPALM_REQUIRE_PWSH_TESTS=1 requires pwsh on PATH').toBeTruthy();
		}
		if (process.env.OPENPALM_REQUIRE_WINDOWS_POWERSHELL_TESTS === '1') {
			expect(
				windowsPowerShell,
				'OPENPALM_REQUIRE_WINDOWS_POWERSHELL_TESTS=1 requires Windows PowerShell on PATH'
			).toBeTruthy();
		}
	});

	powershellIt('fails a script process but does not close an irm | iex-style caller', () => {
		const dir = mkdtempSync(join(tmpdir(), 'setup-ps1-failure-'));
		try {
			const fakeCli = join(dir, process.platform === 'win32' ? 'openpalm-failing.cmd' : 'openpalm-failing');
			writeFileSync(fakeCli, process.platform === 'win32' ? '@exit /b 23\r\n' : '#!/bin/sh\nexit 23\n');
			if (process.platform !== 'win32') chmodSync(fakeCli, 0o755);

			const escapedCli = fakeCli.replaceAll("'", "''");
			const variables = `$Dest = '${escapedCli}'\n$Version = '1.2.3'\n$PassthroughArgs = @()\n`;

			for (const [index, powershellExecutable] of powershellExecutables.entries()) {
				const fileHarness = join(dir, `run-installer-footer-${index}.ps1`);
				writeFileSync(fileHarness, `$ErrorActionPreference = 'Stop'\n${variables}${installFooter}`);
				const fileResult = Bun.spawnSync({
					cmd: [powershellExecutable, '-NoProfile', '-NonInteractive', '-File', fileHarness],
					stdout: 'pipe',
					stderr: 'pipe'
				});
				expect(fileResult.exitCode).not.toBe(0);
				expect(`${fileResult.stdout}${fileResult.stderr}`).toContain(
					'openpalm install failed with exit code 23'
				);

				const inlineHarness = [
					"$ErrorActionPreference = 'Stop'",
					variables,
					"$InstallerFooter = @'",
					installFooter,
					"'@",
					'try { Invoke-Expression $InstallerFooter } catch { Write-Output "caught:$($_.Exception.Message)" }',
					"Write-Output 'shell-survived'"
				].join('\n');
				const inlineHarnessPath = join(dir, `invoke-expression-harness-${index}.ps1`);
				writeFileSync(inlineHarnessPath, inlineHarness);
				const inlineResult = Bun.spawnSync({
					cmd: [powershellExecutable, '-NoProfile', '-NonInteractive', '-File', inlineHarnessPath],
					stdout: 'pipe',
					stderr: 'pipe'
				});
				const stdout = inlineResult.stdout.toString('utf8');
				expect(inlineResult.exitCode, inlineResult.stderr.toString()).toBe(0);
				expect(stdout).toContain('caught:openpalm install failed with exit code 23');
				expect(stdout).toContain('shell-survived');
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, POWERSHELL_SPAWN_TIMEOUT_MS);
});

describe('setup.ps1 caller ErrorActionPreference', () => {
	const source = readFileSync(join(import.meta.dir, 'setup.ps1'), 'utf8');
	const saveLine = findLine(source, '$OpenPalmPreviousErrorActionPreference = $ErrorActionPreference');
	const setLine = findLine(source, "$ErrorActionPreference = 'Stop'");
	const finallyMatch = source.match(
		/\} finally \{\r?\n\s+\$ErrorActionPreference = \$OpenPalmPreviousErrorActionPreference\r?\n\}\s*$/
	);
	if (!finallyMatch) throw new Error('Could not locate setup.ps1 preference-restoring finally block');

	it('wraps the shipped script in the preference-restoring try/finally', () => {
		expect(source.indexOf(saveLine)).toBeLessThan(source.indexOf(setLine));
		expect(source.indexOf('try {', source.indexOf(saveLine))).toBeLessThan(source.indexOf(setLine));
		expect(finallyMatch.index).toBeGreaterThan(source.indexOf('& $Dest install'));
	});

	const pwsh = Bun.which('pwsh');
	const windowsPowerShell = process.platform === 'win32' ? Bun.which('powershell') : null;
	const powershellExecutables = [...new Set([pwsh, windowsPowerShell].filter((value) => value !== null))];
	const powershellIt = powershellExecutables.length > 0 ? it : it.skip;

	powershellIt('restores caller session state after controlled success and failure paths', () => {
		const dir = mkdtempSync(join(tmpdir(), 'setup-ps1-preference-'));
		try {
			for (const [shellIndex, powershellExecutable] of powershellExecutables.entries()) {
				for (const [caseIndex, body] of [
					[0, 'Write-Output "inside:$ErrorActionPreference"'],
					[1, 'Write-Output "inside:$ErrorActionPreference"\nthrow "controlled failure"']
				] as const) {
					const contract = [saveLine, 'try {', setLine, body, finallyMatch[0].trimEnd()].join('\n');
					const harness = [
						"$ErrorActionPreference = 'Continue'",
						"$Contract = @'",
						contract,
						"'@",
						'try { Invoke-Expression $Contract } catch { Write-Output "caught:$($_.Exception.Message)" }',
						'Write-Output "after:$ErrorActionPreference"'
					].join('\n');
					const harnessPath = join(dir, `preference-${shellIndex}-${caseIndex}.ps1`);
					writeFileSync(harnessPath, harness);
					const result = Bun.spawnSync({
						cmd: [powershellExecutable, '-NoProfile', '-NonInteractive', '-File', harnessPath],
						stdout: 'pipe',
						stderr: 'pipe'
					});
					const stdout = result.stdout.toString('utf8');
					expect(result.exitCode, result.stderr.toString()).toBe(0);
					expect(stdout).toContain('inside:Stop');
					expect(stdout).toContain('after:Continue');
					if (caseIndex === 1) expect(stdout).toContain('caught:controlled failure');
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, POWERSHELL_SPAWN_TIMEOUT_MS);
});
