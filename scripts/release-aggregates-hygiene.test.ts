import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

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
