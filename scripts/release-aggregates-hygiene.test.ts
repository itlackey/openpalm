import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CLI_BINARIES,
	checksumFor,
	expectedClaudeExtensionAsset,
	expectedAdminAssets,
	readElectronProductName,
	requiredReleaseAssets,
	validateReleaseAssets,
	writeReleaseAssetManifest
} from './validate-release-assets.mjs';

const ROOT = join(import.meta.dir, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

type Manifest = {
	private?: boolean;
	scripts?: Record<string, string>;
};

function readJson(relPath: string): Manifest {
	return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8')) as Manifest;
}

describe('product package boundary', () => {
	test('the root check covers every active package', () => {
		const check = readJson('package.json').scripts?.check ?? '';
		for (const packageName of ['lib', 'guardian', 'portal', 'cli', 'electron', 'claude-desktop']) {
			expect(check).toContain(`packages/${packageName}`);
		}
	});

	for (const packagePath of [
		'packages/lib/package.json',
		'packages/skeleton/package.json',
		'packages/guardian/package.json',
		'packages/portal/package.json',
		'packages/electron/package.json',
		'packages/claude-desktop/package.json'
	]) {
		test(`${packagePath} is source-only`, () => {
			expect(readJson(packagePath).private).toBe(true);
		});
	}
});

describe('release manifest', () => {
	const release = JSON.parse(readFileSync(join(ROOT, '.github/release-manifest.json'), 'utf8')) as {
		manifests: string[];
		compose: string[];
	};

	test('lists every versioned manifest once', () => {
		expect(new Set(release.manifests).size).toBe(release.manifests.length);
		expect(release.manifests).toContain('packages/electron/package.json');
		expect(release.compose).toEqual(['packages/skeleton/system/stack/stack.compose.yml']);
	});

	test('every listed manifest exists on disk', () => {
		for (const manifest of release.manifests) {
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

	test('every runtime image is built, scanned, and smoked on both supported architectures', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'gates.yml'), 'utf8')) as {
			jobs: {
				images: {
					'runs-on': string;
					strategy: {
						matrix: {
							platform: string[];
							image: string[];
							include: Array<{ image?: string; file?: string; platform?: string; runner?: string }>;
						};
					};
					steps: Array<{
						name?: string;
						uses?: string;
						with?: Record<string, unknown>;
						run?: string;
					}>;
				};
			};
		};
		const images = workflow.jobs.images;
		expect(images.strategy.matrix.platform).toEqual(['linux/amd64', 'linux/arm64']);
		expect(images.strategy.matrix.image).toEqual(['assistant', 'guardian', 'portal']);
		expect(
			images.strategy.matrix.include
				.map((entry) => entry.image)
				.filter(Boolean)
				.sort()
		).toEqual(['assistant', 'guardian', 'portal']);
		expect(images['runs-on']).toBe('${{ matrix.runner }}');
		expect(images.strategy.matrix.include).toContainEqual({
			platform: 'linux/arm64',
			runner: 'ubuntu-24.04-arm'
		});
		expect(images.strategy.matrix.include).toContainEqual({
			platform: 'linux/amd64',
			runner: 'ubuntu-latest'
		});
		expect(images.steps.some((step) => step.uses === 'docker/setup-qemu-action@v3')).toBe(false);
		expect(
			images.steps.some((step) => step.name === 'Assert native architecture for runtime tests')
		).toBe(true);
		const build = images.steps.find((step) => step.uses === 'docker/build-push-action@v6');
		expect(build?.with?.platforms).toBe('${{ matrix.platform }}');
		expect(
			images.steps.filter((step) => step.uses?.startsWith('aquasecurity/trivy-action@')).length
		).toBe(3);
		const scans = images.steps.filter((step) =>
			step.uses?.startsWith('aquasecurity/trivy-action@')
		);
		expect(
			scans.some(
				(step) =>
					step.with?.severity === 'CRITICAL' &&
					step.with?.['exit-code'] === '1' &&
					step.with?.['ignore-unfixed'] !== true
			)
		).toBe(true);
		expect(
			scans.some(
				(step) =>
					step.with?.severity === 'HIGH' &&
					step.with?.['exit-code'] === '1' &&
					step.with?.['ignore-unfixed'] === true
			)
		).toBe(true);
		expect(images.steps.some((step) => step.run?.includes('scripts/smoke-image.sh'))).toBe(true);
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

	test('every active image installs from the audited root lock', () => {
		const root = readJson('package.json') as Manifest & { workspaces?: string[] };
		expect(root.workspaces).toContain('containers/assistant/tools');
		expect(root.workspaces).toContain('containers/guardian/tools');
		for (const dockerfile of [
			'containers/assistant/Dockerfile',
			'containers/guardian/Dockerfile',
			'containers/portal/Dockerfile'
		]) {
			const source = readFileSync(join(ROOT, dockerfile), 'utf8');
			expect(source).toContain('COPY package.json bun.lock ./');
			expect(source).toContain('--frozen-lockfile');
		}
	});
});

describe('portal image source boundary', () => {
	test('copies only the unified private portal package', () => {
		const dockerfile = readFileSync(join(ROOT, 'containers/portal/Dockerfile'), 'utf8');
		expect(dockerfile).toContain('COPY packages/portal/package.json');
		expect(dockerfile).toContain('COPY packages/portal/src');
		expect(dockerfile).not.toContain('containers/portal/tools/package.json');
	});
});

describe('release completeness gate', () => {
	const productName = readElectronProductName();

	test('the builder declares the optional Admin product', () => {
		expect(productName).toBe('OpenPalm Admin');
	});

	test('Admin artifacts have explicit updater-free, dash-safe names', () => {
		const builder = readFileSync(join(ROOT, 'packages/electron/electron-builder.yml'), 'utf8');
		expect(builder).toContain('publish: null');
		expect(builder).toContain('artifactName: OpenPalm-Admin-${version}-${arch}-${os}.${ext}');
		expect(builder).toContain('artifactName: OpenPalm-Admin-Setup-${version}.${ext}');
	});

	test('the cli job matrix and CLI_BINARIES stay in lockstep', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: { cli: { strategy: { matrix: { include: Array<{ asset: string }> } } } };
		};
		const matrixAssets = workflow.jobs.cli.strategy.matrix.include.map((entry) => entry.asset);
		// The Actions matrix must stay static YAML, so this is the one
		// hand-maintained copy of the CLI asset list; every other consumer in
		// this repo's release tooling derives from CLI_BINARIES instead of
		// repeating it, and this test is what keeps the two matched.
		expect(matrixAssets.sort()).toEqual([...CLI_BINARIES].sort());
	});

	test('release assembly downloads every OpenPalm artifact and creates checksums', () => {
		const release = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
		expect(release).toContain('pattern: openpalm-*');
		expect(release).toContain('sha256sum -- * > checksums-sha256.txt');
		expect(release).toContain('node scripts/validate-release-assets.mjs --write-manifest');
	});

	test('the MCPB job is a required release dependency', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: {
				'claude-extension': { steps: Array<{ run?: string }> };
				release: { needs: string[] };
			};
		};
		expect(workflow.jobs.release.needs).toContain('claude-extension');
		expect(
			workflow.jobs['claude-extension'].steps.some(
				(step) => step.run === 'bun run --cwd packages/claude-desktop pack'
			)
		).toBe(true);
	});

	test('release calls the shared gates workflow', () => {
		const release = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: { gates: { uses?: string } };
		};
		expect(release.jobs.gates.uses).toBe('./.github/workflows/gates.yml');
	});

	test('publishes only on GitHub with its built-in token and verifies uploads', () => {
		const source = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
		const workflow = Bun.YAML.parse(source) as {
			jobs: { release: { steps: Array<{ run?: string; env?: Record<string, string> }> } };
		};
		const publish = workflow.jobs.release.steps.find((step) =>
			step.run?.includes('gh release download')
		);
		expect(publish?.env?.GH_TOKEN).toBe('${{ github.token }}');
		expect(publish?.run).toContain('--target "${RELEASE_SHA}"');
		expect(publish?.run).toContain('--prerelease --latest=false');
		expect(publish?.run).toContain('sha256sum --check --strict checksums-sha256.txt');
		expect(publish?.run).toContain('--draft=false');
		expect(source).not.toMatch(/GITEA_|code\.lab|publish-gitea/);
	});

	test('the shared gate validates all active packages and optional artifacts', () => {
		const gates = readFileSync(join(WORKFLOWS, 'gates.yml'), 'utf8');
		expect(gates).toContain('run: bun run check');
		expect(gates).toContain('run: bun run test');
		expect(gates).toContain('run: bun run lint');
		expect(gates).toContain('bun run --cwd packages/electron bundle');
		expect(gates).toContain('bun run --cwd packages/claude-desktop pack');
	});

	test('every Admin target is required with an unambiguous architecture', () => {
		expect(expectedAdminAssets('1.4.2', productName)).toEqual([
			'OpenPalm-Admin-1.4.2-arm64-mac.zip',
			'OpenPalm-Admin-1.4.2-x64-mac.zip',
			'OpenPalm-Admin-1.4.2-x86_64-linux.AppImage',
			'OpenPalm-Admin-1.4.2-arm64-linux.AppImage',
			'OpenPalm-Admin-Setup-1.4.2.exe'
		]);
	});

	test('required assets cover CLI, Admin, MCPB, and checksums without updater feeds', () => {
		const required = requiredReleaseAssets('2.0.0-beta.1', productName);
		for (const binary of CLI_BINARIES) expect(required).toContain(binary);
		for (const asset of expectedAdminAssets('2.0.0-beta.1', productName))
			expect(required).toContain(asset);
		expect(required).toContain(expectedClaudeExtensionAsset('2.0.0-beta.1'));
		expect(required).toContain('OpenPalm-Admin-Setup-2.0.0-beta.1.exe');
		expect(required).toContain('checksums-sha256.txt');
		expect(required.some((name) => name.endsWith('.yml'))).toBe(false);
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

		const lines = withoutChecksums.map((name) => {
			const hash = createHash('sha256')
				.update(readFileSync(join(dir, name)))
				.digest('hex');
			return `${hash}  ${name}`;
		});
		writeFileSync(join(dir, 'checksums-sha256.txt'), `${lines.join('\n')}\n`);
		writeReleaseAssetManifest(dir, version, productName);
		return required;
	}

	test('validateReleaseAssets passes a complete, checksummed asset set', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '1.4.2');
			expect(validateReleaseAssets(dir, '1.4.2', productName)).toEqual([]);
		});
	});

	test('validateReleaseAssets fails closed when every Admin artifact is missing', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '1.4.2');
			const admin = expectedAdminAssets('1.4.2', productName);
			for (const asset of admin) rmSync(join(dir, asset));
			const problems = validateReleaseAssets(dir, '1.4.2', productName);
			for (const asset of admin) expect(problems).toContain(`Missing release asset: ${asset}`);
			expect(problems.length).toBeGreaterThanOrEqual(admin.length);
		});
	});

	test('validateReleaseAssets catches an Admin artifact corrupted in transit', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '1.4.2');
			writeFileSync(join(dir, 'OpenPalm-Admin-1.4.2-arm64-mac.zip'), 'corrupted-in-transit');
			const problems = validateReleaseAssets(dir, '1.4.2', productName);
			expect(problems).toContain('Checksum mismatch for OpenPalm-Admin-1.4.2-arm64-mac.zip');
		});
	});

	test('validateReleaseAssets rejects undeclared release files in the manifest', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '1.4.2');
			const manifestPath = join(dir, 'release-assets-manifest.json');
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { assets: string[] };
			manifest.assets.push('undeclared-updater.yml');
			writeFileSync(manifestPath, JSON.stringify(manifest));
			const problems = validateReleaseAssets(dir, '1.4.2', productName);
			expect(problems).toContain('Unexpected release asset in manifest: undeclared-updater.yml');
		});
	});
});
