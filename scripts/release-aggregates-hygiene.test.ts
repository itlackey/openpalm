import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CLI_BINARIES,
	checksumFor,
	desktopAssetName,
	expectedDesktopAssets,
	expectedUpdaterFeeds,
	readElectronProductName,
	requiredReleaseAssets,
	validateReleaseAssets
} from './validate-release-assets.mjs';
import { updaterArtifactForFeed } from './validate-updater-feed.mjs';

const ROOT = join(import.meta.dir, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

type Manifest = {
	private?: boolean;
	scripts?: Record<string, string>;
};

function readJson(relPath: string): Manifest {
	return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8')) as Manifest;
}

describe('0.13 product package boundary', () => {
	test('the root check covers the UI and its in-tree shared components', () => {
		expect(readJson('package.json').scripts?.check).toContain('ui:check');
	});

	for (const packagePath of [
		'packages/lib/package.json',
		'packages/skeleton/package.json',
		'packages/ui/package.json'
	]) {
		test(`${packagePath} is source-only`, () => {
			expect(readJson(packagePath).private).toBe(true);
		});
	}
});

describe('release package ownership', () => {
	const groups = JSON.parse(
		readFileSync(join(ROOT, '.github/release-package-groups.json'), 'utf8')
	) as { units: Record<string, string[]> };

	test('each manifest has exactly one canonical owner', () => {
		const manifests = Object.values(groups.units).flat();
		expect(new Set(manifests).size).toBe(manifests.length);
	});

	test('guardian and electron have independent owner groups', () => {
		expect(groups.units.guardian).toEqual(['packages/guardian/package.json']);
		expect(groups.units.electron).toEqual(['packages/electron/package.json']);
		expect(groups.units.platform).toContain('packages/skeleton/package.json');
	});

	test('every listed manifest exists on disk', () => {
		// A group entry pointing at a deleted package silently breaks release
		// version stamping for that whole unit — the admin-tools removal left
		// exactly such a dangling entry behind.
		for (const manifest of Object.values(groups.units).flat()) {
			expect(existsSync(join(ROOT, manifest))).toBe(true);
		}
	});
});

describe('release workflows', () => {
	test('all workflows parse as YAML', () => {
		for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'))) {
			expect(() => Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8'))).not.toThrow();
		}
	});

	test('extension stamping script executes for each release unit', () => {
		const extensionWorkflow = Bun.YAML.parse(
			readFileSync(join(WORKFLOWS, 'publish-extensions.yml'), 'utf8')
		) as {
			jobs: { publish: { steps: Array<{ name?: string; run?: string }> } };
		};
		const run = extensionWorkflow.jobs.publish.steps.find(
			(step) => step.name === 'Stamp extension version'
		)?.run;
		if (!run) throw new Error('Missing extension workflow step: Stamp extension version');
		for (const [unit, manifest] of [
			['guardian', 'packages/guardian/package.json'],
			['portals', 'packages/portal-sdk/package.json']
		]) {
			const version = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8')).version;
			// Override STAMP to preview mode so this test never writes to package.json
			// or the lockfile, regardless of what the workflow step itself sets.
			const result = Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', run], {
				cwd: ROOT,
				env: { ...process.env, UNIT: unit, VERSION: version, STAMP: 'false' },
				stderr: 'pipe'
			});
			expect(result.exitCode, result.stderr.toString()).toBe(0);
		}
	});
});

describe('image tool pins', () => {
	// core-principles.md: the assistant and Guardian images install OpenCode
	// from their own tools manifests, and those two pins must stay in lockstep.
	test('assistant and guardian opencode-ai pins match', () => {
		const pin = (p: string) =>
			(readJson(p) as { dependencies?: Record<string, string> }).dependencies?.['opencode-ai'];
		const assistant = pin('containers/assistant/tools/package.json');
		expect(assistant).toBeTruthy();
		expect(pin('containers/guardian/tools/package.json')).toBe(assistant);
	});
});

describe('portal image source boundary', () => {
	test('packs the candidate-local SDK and adapters without a baked npm manifest', () => {
		const dockerfile = readFileSync(join(ROOT, 'containers/portal/Dockerfile'), 'utf8');
		for (const source of ['packages/portal-sdk', 'packages/portal-discord', 'packages/portal-slack']) {
			expect(dockerfile).toContain(`COPY ${source}`);
		}
		expect(dockerfile).toContain('bun pm pack');
		expect(dockerfile).not.toContain('containers/portal/tools/package.json');
	});
});

describe('release completeness gate: no CLI-only releases (onboarding-setup-review D1/D4)', () => {
	// electron-builder.yml's actual productName, read once so these tests fail
	// loudly if it is ever renamed rather than silently drifting from reality.
	const productName = readElectronProductName();

	test('electron-builder.yml still declares the productName these tests assume', () => {
		expect(productName).toBe('OpenPalm');
	});

	test('the NSIS build artifact uses the exact dash-safe filename referenced by updater feeds', () => {
		const builder = readFileSync(join(ROOT, 'packages/electron/electron-builder.yml'), 'utf8');
		expect(builder).toContain('artifactName: ${productName}-Setup-${version}.${ext}');
	});

	test('the cli job matrix and CLI_BINARIES stay in lockstep', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: { cli: { strategy: { matrix: { include: Array<{ asset: string }> } } } };
		};
		const matrixAssets = workflow.jobs.cli.strategy.matrix.include.map((entry) => entry.asset);
		// A GitHub Actions matrix must stay static YAML, so this is the one
		// hand-maintained copy of the CLI asset list; every other consumer in
		// this repo's release tooling derives from CLI_BINARIES instead of
		// repeating it, and this test is what keeps the two matched.
		expect(matrixAssets.sort()).toEqual([...CLI_BINARIES].sort());
	});

	test('publish-bootstrap derives its asset list from validate-release-assets.mjs instead of a fourth hand-written copy', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: { 'publish-bootstrap': { steps: Array<{ name?: string; run?: string }> } };
		};
		const run = workflow.jobs['publish-bootstrap'].steps.find(
			(step) => step.name === 'Verify matching public assets before npm'
		)?.run;
		if (!run) throw new Error('Missing publish-bootstrap step: Verify matching public assets before npm');
		expect(run).toContain("from '../scripts/validate-release-assets.mjs'");
		expect(run).not.toContain('openpalm-cli-linux-x64 openpalm-cli-linux-arm64');
	});

	test('dry-run asset assembly runs the release validator that composes updater-feed semantics', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: {
				'assemble-assets': { steps: Array<{ name?: string; run?: string }> };
				docker: { needs: string[] };
			};
		};
		const run = workflow.jobs['assemble-assets'].steps.find(
			(step) => step.name === 'Assemble and validate complete asset manifest'
		)?.run;
		if (!run) throw new Error('Missing assemble-assets validation step');
		expect(run).toContain('node scripts/validate-release-assets.mjs');
		expect(readFileSync(join(ROOT, 'scripts/validate-release-assets.mjs'), 'utf8')).toContain(
			'validateUpdaterFeeds(dir, version, presentFiles, productName)'
		);
		expect(workflow.jobs.docker.needs).toContain('assemble-assets');
		expect(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')).not.toContain(
			'node scripts/validate-updater-feed.mjs'
		);
	});

	test('prerelease assembly renames electron-builder feeds to the release channel', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: { 'assemble-assets': { steps: Array<{ name?: string; run?: string }> } };
		};
		const run = workflow.jobs['assemble-assets'].steps.find(
			(step) => step.name === 'Assemble and validate complete asset manifest'
		)?.run;
		if (!run) throw new Error('Missing assemble-assets validation step');
		expect(run).toContain("const sources = updaterFeedsFor('latest');");
		expect(run).toContain('renameSync(`dist/${sources[index]}`, `dist/${destinations[index]}`)');
	});

	test('CI and release preflight both typecheck Electron', () => {
		const release = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
		const ci = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8');
		expect(release).toContain('bun run --cwd packages/electron typecheck');
		expect(ci).toContain('bun run --cwd packages/electron typecheck');
	});

	test('CI requires the real PowerShell installer contract on a Windows runner', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8')) as {
			jobs: Record<string, { 'runs-on': string; steps: Array<{ env?: Record<string, string>; run?: string }> }>;
		};
		const job = workflow.jobs['powershell-installer-tests'];
		expect(job['runs-on']).toBe('windows-latest');
		const step = job.steps.find((candidate) => candidate.run?.includes('setup-sh-latest-resolver.test.ts'));
		expect(step?.env?.OPENPALM_REQUIRE_PWSH_TESTS).toBe('1');
		expect(step?.env?.OPENPALM_REQUIRE_WINDOWS_POWERSHELL_TESTS).toBe('1');
	});

	test('immutable image collision checks also run read-only during dry runs', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: { docker: { steps: Array<{ name?: string; if?: string; run?: string }> } };
		};
		const steps = workflow.jobs.docker.steps;
		const collision = steps.find((step) => step.name === 'Validate an existing immutable image tag');
		expect(collision?.if).toBeUndefined();
		expect(collision?.run).toContain('docker buildx imagetools inspect');
		const login = steps.find((step) => step.name === 'Login to Docker Hub');
		expect(login?.if).toContain('inputs.dry_run != true');
	});

	test('every desktop target electron-builder.yml configures is required, with names derived from the version', () => {
		expect(expectedDesktopAssets('1.4.2', productName)).toEqual([
			'OpenPalm-1.4.2-arm64-mac.zip',
			'OpenPalm-1.4.2-mac.zip',
			'OpenPalm-Setup-1.4.2.exe',
			'OpenPalm-1.4.2-win.zip',
			'OpenPalm-1.4.2.AppImage',
			'OpenPalm-1.4.2-arm64.AppImage'
		]);
	});

	test('the Intel mac zip carries no arch token, matching the live-release-verified naming (review D2)', () => {
		expect(desktopAssetName(productName, '1.4.2', { platform: 'mac', arch: 'x64', kind: 'zip' })).toBe(
			'OpenPalm-1.4.2-mac.zip'
		);
		expect(desktopAssetName(productName, '1.4.2', { platform: 'mac', arch: 'arm64', kind: 'zip' })).toBe(
			'OpenPalm-1.4.2-arm64-mac.zip'
		);
	});

	test('required assets cover CLI binaries, every desktop artifact, the updater feed, and checksums', () => {
		const required = requiredReleaseAssets('2.0.0-beta.1', productName);
		for (const binary of CLI_BINARIES) expect(required).toContain(binary);
		for (const asset of expectedDesktopAssets('2.0.0-beta.1', productName)) expect(required).toContain(asset);
		for (const feed of expectedUpdaterFeeds('2.0.0-beta.1')) expect(required).toContain(feed);
		expect(required).toContain('beta-linux-arm64.yml');
		expect(required).toContain('OpenPalm-Setup-2.0.0-beta.1.exe');
		expect(required).toContain('checksums-sha256.txt');
		// A beta candidate publishes its own channel feed, never the stable name.
		expect(required).not.toContain('latest.yml');
	});

	test('checksumFor treats the release filename as opaque, including spaces', () => {
		const hash = 'f'.repeat(64);
		const checksums = `${hash}  OpenPalm Setup 1.4.2.exe\n`;
		expect(checksumFor(checksums, 'OpenPalm Setup 1.4.2.exe')).toBe(hash);
	});

	function withDir(run: (dir: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), 'release-assets-'));
		try {
			run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	function writeCompleteDist(dir: string, version: string): string[] {
		const required = requiredReleaseAssets(version, productName);
		const withoutChecksums = required.filter((name) => name !== 'checksums-sha256.txt');
		for (const name of withoutChecksums) writeFileSync(join(dir, name), `content-of-${name}`);

		for (const feed of expectedUpdaterFeeds(version)) {
			const artifact = updaterArtifactForFeed(feed, version, productName);
			if (!artifact) throw new Error(`No updater artifact contract for ${feed}`);
			const hash = createHash('sha512')
				.update(readFileSync(join(dir, artifact.physicalArtifact)))
				.digest('base64');
			writeFileSync(
				join(dir, feed),
				`version: ${version}\nfiles:\n  - url: ${artifact.feedArtifact}\n    sha512: ${hash}\n    size: 1\n    blockMapSize: 1\npath: ${artifact.feedArtifact}\nsha512: ${hash}\n`
			);
		}

		const lines = withoutChecksums.map((name) => {
			const hash = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
			return `${hash}  ${name}`;
		});
		writeFileSync(join(dir, 'checksums-sha256.txt'), `${lines.join('\n')}\n`);
		writeFileSync(
			join(dir, 'release-assets-manifest.json'),
			JSON.stringify({ version, assets: [...required].sort() }, null, 2)
		);
		return required;
	}

	test('validateReleaseAssets passes a complete, checksummed asset set', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '1.4.2');
			expect(validateReleaseAssets(dir, '1.4.2', productName)).toEqual([]);
		});
	});

	test('validateReleaseAssets fails closed when every desktop artifact is missing — the exact 0.12.52 gap', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '1.4.2');
			const desktop = expectedDesktopAssets('1.4.2', productName);
			for (const asset of desktop) rmSync(join(dir, asset));
			const problems = validateReleaseAssets(dir, '1.4.2', productName);
			for (const asset of desktop) expect(problems).toContain(`Missing release asset: ${asset}`);
			expect(problems.length).toBeGreaterThanOrEqual(desktop.length);
		});
	});

	test('validateReleaseAssets fails closed when the updater feed is missing', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '1.4.2');
			const feeds = expectedUpdaterFeeds('1.4.2');
			for (const feed of feeds) rmSync(join(dir, feed));
			const problems = validateReleaseAssets(dir, '1.4.2', productName);
			for (const feed of feeds) expect(problems).toContain(`Missing release asset: ${feed}`);
		});
	});

	test('validateReleaseAssets catches a desktop artifact corrupted in transit even though it is present', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '1.4.2');
			writeFileSync(join(dir, 'OpenPalm-1.4.2-arm64-mac.zip'), 'corrupted-in-transit');
			const problems = validateReleaseAssets(dir, '1.4.2', productName);
			expect(problems).toContain('Checksum mismatch for OpenPalm-1.4.2-arm64-mac.zip');
		});
	});

	test('validateReleaseAssets includes semantic updater-feed validation', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '1.4.2');
			const feed = expectedUpdaterFeeds('1.4.2')[0];
			const feedPath = join(dir, feed);
			writeFileSync(feedPath, readFileSync(feedPath, 'utf8').replace(/sha512: .+/, 'sha512: invalid'));
			const problems = validateReleaseAssets(dir, '1.4.2', productName);
			expect(problems.some((problem) => problem.includes('sha512 does not match'))).toBe(true);
		});
	});
});
