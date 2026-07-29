import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));

function readRelative(path: string): string {
	return readFileSync(`${ROOT_DIR}/${path}`, 'utf8');
}

describe('portal image bake contract', () => {
	test('file tarball manifest satisfies an adapter without registry access', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-portal-install-'));
		try {
			const sdk = join(root, 'sdk');
			const adapter = join(root, 'adapter');
			const artifacts = join(root, 'artifacts');
			const tools = join(root, 'tools');
			for (const directory of [sdk, adapter, artifacts, tools]) mkdirSync(directory);
			writeFileSync(
				join(sdk, 'package.json'),
				JSON.stringify({ name: '@openpalm/portal-sdk', version: '99.0.0', files: ['index.js'] })
			);
			writeFileSync(join(sdk, 'index.js'), 'export const candidate = true;\n');
			writeFileSync(
				join(adapter, 'package.json'),
				JSON.stringify({
					name: '@openpalm/test-portal',
					version: '99.0.0',
					dependencies: { '@openpalm/portal-sdk': '99.0.0' },
					files: ['index.js']
				})
			);
			writeFileSync(
				join(adapter, 'index.js'),
				"export { candidate } from '@openpalm/portal-sdk';\n"
			);

			for (const directory of [sdk, adapter]) {
				const packed = Bun.spawnSync(['bun', 'pm', 'pack', '--destination', artifacts, '--quiet'], {
					cwd: directory,
					stderr: 'pipe'
				});
				expect(packed.exitCode, packed.stderr.toString()).toBe(0);
			}
			writeFileSync(
				join(tools, 'package.json'),
				JSON.stringify({
					private: true,
					dependencies: {
						'@openpalm/portal-sdk': `file:${join(artifacts, 'openpalm-portal-sdk-99.0.0.tgz')}`,
						'@openpalm/test-portal': `file:${join(artifacts, 'openpalm-test-portal-99.0.0.tgz')}`
					},
					overrides: {
						'@openpalm/portal-sdk': `file:${join(artifacts, 'openpalm-portal-sdk-99.0.0.tgz')}`
					}
				})
			);
			const adapterInstall = Bun.spawnSync(
				['bun', 'install', '--production', '--registry', 'http://127.0.0.1:9'],
				{ cwd: tools, stderr: 'pipe' }
			);
			expect(adapterInstall.exitCode, adapterInstall.stderr.toString()).toBe(0);
			expect(
				JSON.parse(
					readFileSync(join(tools, 'node_modules/@openpalm/portal-sdk/package.json'), 'utf8')
				).version
			).toBe('99.0.0');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('startup script no longer installs adapters at boot', () => {
		const startScript = readRelative('containers/portal/start.sh');

		expect(startScript).not.toContain('bun add');
		expect(startScript).toContain('PORTAL_PACKAGE must name a baked adapter package');
	});

	test('startup script runs under strict bash and guards optional vars', () => {
		const startScript = readRelative('containers/portal/start.sh');

		// Matches sibling entrypoints (voice/guardian/assistant) for fail-fast behaviour.
		expect(startScript).toContain('set -euo pipefail');
		expect(startScript).not.toMatch(/^set -e\s*$/m);
		// Under `-u`, the optional PORTAL_PACKAGE check must not trip on an unset var —
		// it must fall back to empty so the friendly error path still runs.
		expect(startScript).toContain('[ -z "${PORTAL_PACKAGE:-}" ]');
		expect(startScript).not.toContain('[ -z "$PORTAL_PACKAGE" ]');
	});

	test('docker image bakes the local SDK and first-party adapter candidates', () => {
		const dockerfile = readRelative('containers/portal/Dockerfile');

		expect(dockerfile).toContain(
			'COPY packages/portal-sdk /opt/openpalm/local-src/packages/portal-sdk'
		);
		expect(dockerfile).toContain(
			'COPY packages/portal-discord /opt/openpalm/local-src/packages/portal-discord'
		);
		expect(dockerfile).toContain(
			'COPY packages/portal-slack /opt/openpalm/local-src/packages/portal-slack'
		);
		expect(dockerfile).toContain('bun pm pack');
		expect(dockerfile).toContain('"@openpalm/portal-sdk":"file:%s"');
		expect(dockerfile).toContain('"overrides":{"@openpalm/portal-sdk":"file:%s"}');
		expect(dockerfile).toContain('"@openpalm/discord-portal":"file:%s"');
		expect(dockerfile).toContain('(cd /opt/openpalm/tools && bun install --production)');
		expect(dockerfile).toContain(
			'COPY containers/portal/portal-entrypoint.ts /app/portal-entrypoint.ts'
		);
		expect(dockerfile).not.toContain('containers/portal/tools/package.json');
	});

	test('managed portal compose uses baked package names, not dist-tags', () => {
		const compose = readRelative('packages/skeleton/system/stack/portals.compose.yml');

		expect(compose).not.toContain('@latest');
		expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/discord-portal"');
		expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/slack-portal"');
	});
});
