import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'build-host-assets.mjs'), 'utf8');

describe('host-assets builder contract', () => {
	test('builds the single named release asset with all required roots', () => {
		expect(source).toContain('openpalm-host-assets-${version}.tar.gz');
		expect(source).toMatch(/'manifest\.json',[\s\S]*'ui',[\s\S]*'skeleton'/);
		expect(source).toContain('platformVersion: version');
		expect(source).toContain('minHarnessContract: harness');
	});

	test('uses deterministic tar metadata and emits a checksum', () => {
		expect(source).toContain("'--sort=name'");
		expect(source).toContain("'--mtime=UTC 1970-01-01'");
		expect(source).toContain('.sha256');
	});
});
