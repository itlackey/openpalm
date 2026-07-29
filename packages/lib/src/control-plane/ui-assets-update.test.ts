import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar } from 'tar';
import { checkAndUpdateSkeleton, checkAndUpdateUiBuild } from './ui-assets.js';

const realFetch = globalThis.fetch;
const originalHome = process.env.OP_HOME;

afterEach(() => {
	globalThis.fetch = realFetch;
	if (originalHome === undefined) delete process.env.OP_HOME;
	else process.env.OP_HOME = originalHome;
});

async function mockHostAssets(root: string, version: string): Promise<void> {
	const source = join(root, 'release-source');
	const archive = join(root, 'release.tar.gz');
	mkdirSync(join(source, 'ui'), { recursive: true });
	mkdirSync(join(source, 'skeleton', 'system', 'stack'), { recursive: true });
	writeFileSync(
		join(source, 'manifest.json'),
		JSON.stringify({ platformVersion: version, minHarnessContract: 1 })
	);
	writeFileSync(join(source, 'ui', 'index.js'), 'export {};\n');
	writeFileSync(join(source, 'skeleton', 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
	await createTar({ gzip: true, file: archive, cwd: source }, ['manifest.json', 'ui', 'skeleton']);
	const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
	const checksum = createHash('sha256').update(bytes).digest('hex');
	const assetName = `openpalm-host-assets-${version}.tar.gz`;
	globalThis.fetch = (async (input) => {
		const url = String(input);
		if (url.includes('/releases?')) {
			return new Response(
				JSON.stringify([
					{
						tag_name: version,
						prerelease: false,
						draft: false,
						assets: [
							{ name: assetName, browser_download_url: 'https://example.test/assets' },
							{ name: `${assetName}.sha256`, browser_download_url: 'https://example.test/checksum' }
						]
					}
				]),
				{ status: 200 }
			);
		}
		return url.endsWith('/checksum')
			? new Response(checksum, { status: 200 })
			: new Response(bytes.slice(), { status: 200 });
	}) as typeof fetch;
}

function oldBackup(home: string, name: string, age: number): void {
	const path = join(home, 'data', 'backups', name);
	mkdirSync(path, { recursive: true });
	const when = new Date(Date.now() - age);
	utimesSync(path, when, when);
}

describe('host-assets update policy', () => {
	test('does not automatically cross a major platform version', async () => {
		const home = mkdtempSync(join(tmpdir(), 'ui-assets-major-'));
		process.env.OP_HOME = home;
		try {
			const dataDir = join(home, 'data');
			mkdirSync(join(dataDir, 'ui'), { recursive: true });
			writeFileSync(join(dataDir, 'ui', 'index.js'), 'old\n');
			writeFileSync(join(dataDir, 'ui', '.openpalm-ui-version'), '0.13.0\n');
			await mockHostAssets(home, '1.0.0');

			const result = await checkAndUpdateUiBuild('0.13.0', dataDir, 'stable');

			expect(result).toMatchObject({ updated: false, latestVersion: '1.0.0' });
			await expect(Bun.file(join(dataDir, 'ui', 'index.js')).text()).resolves.toBe('old\n');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('bounds UI and skeleton hot-swap backups independently', async () => {
		const home = mkdtempSync(join(tmpdir(), 'ui-assets-prune-'));
		process.env.OP_HOME = home;
		try {
			const dataDir = join(home, 'data');
			mkdirSync(join(dataDir, 'ui'), { recursive: true });
			mkdirSync(join(home, 'system', 'stack'), { recursive: true });
			writeFileSync(join(dataDir, 'ui', 'index.js'), 'old\n');
			writeFileSync(join(dataDir, 'ui', '.openpalm-ui-version'), '0.13.0\n');
			writeFileSync(join(home, '.skeleton-version'), '0.13.0\n');
			for (let i = 1; i <= 4; i += 1) {
				oldBackup(home, `ui-${i}`, 10_000 + i);
				oldBackup(home, `skeleton-${i}`, 20_000 + i);
			}
			await mockHostAssets(home, '0.13.1');

			expect((await checkAndUpdateUiBuild('0.13.0', dataDir, 'stable')).updated).toBe(true);
			expect((await checkAndUpdateSkeleton('0.13.0', home, dataDir, 'stable')).updated).toBe(true);

			const backups = readdirSync(join(home, 'data', 'backups'));
			expect(backups.filter((name) => name.startsWith('ui-'))).toHaveLength(3);
			expect(backups.filter((name) => name.startsWith('skeleton-'))).toHaveLength(3);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('leaves image pins for the locked lifecycle update after a skeleton hot-swap', async () => {
		const home = mkdtempSync(join(tmpdir(), 'skeleton-image-pins-'));
		process.env.OP_HOME = home;
		try {
			const dataDir = join(home, 'data');
			mkdirSync(join(home, 'system', 'stack'), { recursive: true });
			mkdirSync(join(home, 'state'), { recursive: true });
			writeFileSync(join(home, '.skeleton-version'), '0.13.0\n');
			writeFileSync(
				join(home, 'state', 'stack.env'),
				'OP_ASSISTANT_VERSION=0.13.0\nOP_GUARDIAN_VERSION=0.13.0\nOP_PORTAL_VERSION=custom\n'
			);
			await mockHostAssets(home, '0.13.1');

			expect((await checkAndUpdateSkeleton('0.13.0', home, dataDir, 'stable')).updated).toBe(true);

			const env = readFileSync(join(home, 'state', 'stack.env'), 'utf8');
			expect(env).toContain('OP_ASSISTANT_VERSION=0.13.0');
			expect(env).toContain('OP_GUARDIAN_VERSION=0.13.0');
			expect(env).toContain('OP_PORTAL_VERSION=custom');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
