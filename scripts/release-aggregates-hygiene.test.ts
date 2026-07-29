import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
		expect(groups.units.electron).toEqual([
			'packages/electron/package.json',
			'packages/electron/admin-tools/package.json'
		]);
		expect(groups.units.platform).toContain('packages/skeleton/package.json');
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
