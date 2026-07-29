import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const release = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
const extensions = readFileSync(join(WORKFLOWS, 'publish-extensions.yml'), 'utf8');
const extensionWorkflow = Bun.YAML.parse(extensions) as {
	jobs: { publish: { steps: Array<{ name?: string; run?: string }> } };
};

function extensionStep(name: string): string {
	const run = extensionWorkflow.jobs.publish.steps.find((step) => step.name === name)?.run;
	if (!run) throw new Error(`Missing extension workflow step: ${name}`);
	return run;
}

describe('0.13 release workflow', () => {
	test('all workflows parse as YAML', () => {
		for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'))) {
			expect(() => Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8'))).not.toThrow();
		}
	});

	test('product npm is limited to the bootstrap and extensions are separate', () => {
		expect(release).toContain('Publish openpalm bootstrap only');
		for (const packageName of [
			'@openpalm/ui',
			'@openpalm/skeleton',
			'@openpalm/lib',
			'@openpalm/guardian',
			'@openpalm/portal-sdk'
		]) {
			expect(release).not.toContain(`package-name: '${packageName}'`);
		}
		expect(readFileSync(join(WORKFLOWS, 'publish-extensions.yml'), 'utf8')).toContain(
			'Independent extension release'
		);
	});

	test('images and CLI builds do not depend on npm jobs', () => {
		expect(release).toContain('Build immutable image from candidate-local source');
		expect(release).toContain('Build CLI binary without npm');
		expect(release).not.toContain('publish-npm-package.yml');
	});

	test('assets are assembled once and published on one summary release', () => {
		expect(release).toContain('scripts/build-host-assets.mjs');
		expect(release).toContain('scripts/validate-release-assets.mjs');
		expect(release).toContain('release-assets-manifest.json');
		expect(release).toContain('args=(release create "${VERSION}"');
		expect(release).not.toContain('deploy-bundle');
		expect(release).toContain("assets.push('checksums-sha256.txt')");
	});

	test('extensions are tested and publish the shared SDK before adapters', () => {
		expect(extensions).toContain(
			'bun test packages/guardian packages/portal-sdk packages/portal-discord packages/portal-slack'
		);
		expect(extensions.indexOf('openpalm-portal-sdk-*.tgz')).toBeLessThan(
			extensions.indexOf('openpalm-discord-portal-*.tgz')
		);
	});

	test('extension version validation script executes for each release unit', () => {
		for (const [unit, manifest] of [
			['guardian', 'packages/guardian/package.json'],
			['portals', 'packages/portal-sdk/package.json']
		]) {
			const version = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8')).version;
			const result = Bun.spawnSync(
				['bash', '-euo', 'pipefail', '-c', extensionStep('Validate extension versions')],
				{
					cwd: ROOT,
					env: { ...process.env, UNIT: unit, VERSION: version },
					stderr: 'pipe'
				}
			);
			expect(result.exitCode, result.stderr.toString()).toBe(0);
		}
	});

	test('portal image packs adapters inside the root workspace', () => {
		const dockerfile = readFileSync(join(ROOT, 'containers', 'portal', 'Dockerfile'), 'utf8');
		expect(dockerfile).toContain(
			'COPY containers/portal/workspace.package.json /opt/openpalm/local-src/package.json'
		);
		expect(dockerfile).toContain('bun install --lockfile-only --ignore-scripts');
		expect(dockerfile).toContain('/opt/openpalm/local-src/packages/portal-discord');
	});

	test('assistant image packs UI inside a candidate-local workspace', () => {
		const dockerfile = readFileSync(join(ROOT, 'containers', 'assistant', 'Dockerfile'), 'utf8');
		const workspace = JSON.parse(
			readFileSync(join(ROOT, 'containers', 'assistant', 'workspace.package.json'), 'utf8')
		);
		expect(workspace.workspaces).toEqual(['packages/lib', 'packages/ui']);
		expect(dockerfile).toContain('COPY packages/lib /opt/openpalm/local-src/packages/lib');
		expect(dockerfile).toContain('bun install --lockfile-only --ignore-scripts');
	});

	test('product candidate stamps both Electron release manifests', () => {
		expect(release).toContain('UNIT=electron node scripts/bump-unit.mjs');
		const groups = JSON.parse(
			readFileSync(join(ROOT, '.github/release-package-groups.json'), 'utf8')
		);
		expect(groups.units.electron).toEqual([
			'packages/electron/package.json',
			'packages/electron/admin-tools/package.json'
		]);
	});

	test('dev setup supplies the exact managed image pins', () => {
		const source = readFileSync(join(ROOT, 'scripts/dev-setup.sh'), 'utf8');
		expect(source).toContain('OP_ASSISTANT_VERSION OP_GUARDIAN_VERSION OP_PORTAL_VERSION');
		expect(source).toContain('printf \'%s=dev\\n\' "$image_var"');
	});

	test('upgrade smoke sources current-era skeletons from checksummed host assets', () => {
		const fixture = readFileSync(join(ROOT, 'scripts/rootless-smoke-fixture.sh'), 'utf8');
		expect(fixture).toContain('openpalm-host-assets-${version}.tar.gz');
		expect(fixture).toContain('checksums-sha256.txt');
		expect(fixture).toContain(
			'tar xzf "${workdir}/${asset}" -C "$home" --strip-components=1 skeleton'
		);
	});

	test('live publication is protected and permissions are job scoped', () => {
		expect(release).toContain('refs/heads/main');
		expect(release).toContain('refs/heads/release/');
		expect(release).not.toContain('packages: write');
		expect(release).not.toContain('secrets: inherit');
	});

	test('source and the product tag are pushed atomically before the summary release', () => {
		expect(release).toContain('git push --atomic');
		expect(release.indexOf('git push --atomic')).toBeLessThan(
			release.indexOf('args=(release create')
		);
	});

	test('immutable publication is safely resumable for the same candidate tree', () => {
		expect(release).toContain('org.opencontainers.image.source-tree');
		expect(release).toContain('belongs to a different candidate');
		expect(release).toContain('gh release upload "${VERSION}" dist/* --clobber');
		expect(release).toContain('npm view "openpalm@${VERSION}" dist.integrity');
	});

	test('multi-architecture builds and prerelease npm tags are explicit', () => {
		expect(release).toContain('docker/setup-qemu-action@v3');
		expect(release).toContain('npm view "openpalm@${VERSION}" dist.integrity');
		expect(release).toContain('tag=next');
		expect(extensions).toContain('tag=next');
		expect(extensions).toContain('npm view "${spec}" dist.integrity');
	});

	test('setup scripts are version-neutral and not release-stamped', () => {
		for (const file of ['scripts/setup.sh', 'scripts/setup.ps1']) {
			const source = readFileSync(join(ROOT, file), 'utf8');
			expect(source).not.toContain('SCRIPT_VERSION');
			expect(source).not.toContain('$ScriptVersion');
		}
		expect(release).not.toContain('setup.sh');
		expect(release).not.toContain('setup.ps1');
	});
});
