import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dockerfile = readFileSync(
	join(resolve(import.meta.dir, '../../../..'), 'containers/paperclip/Dockerfile'),
	'utf8'
);

describe('Paperclip image contract', () => {
	test('packages only the pinned upstream release at build time', () => {
		expect(dockerfile).toContain('ARG PAPERCLIP_VERSION=2026.722.0');
		expect(dockerfile).toContain(
			'npm install --global --omit=dev "paperclipai@${PAPERCLIP_VERSION}"'
		);
		expect(dockerfile).toContain('prepareEmbeddedPostgresNativeRuntime');
		expect(dockerfile).toContain(
			'CMD ["node", "/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/index.js"]'
		);
		expect(dockerfile).not.toContain('FROM node:22-bookworm-slim\n');
		expect(dockerfile).not.toContain('packages/paperclip-adapter');
		expect(dockerfile).not.toContain('verifier');
		expect(dockerfile).not.toMatch(/ENTRYPOINT/);
	});
});
