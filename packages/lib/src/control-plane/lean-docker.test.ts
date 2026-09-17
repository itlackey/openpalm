import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeProcessEnvironment } from './lean-docker.js';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('lean Compose process environment', () => {
	it('pins OpenPalm interpolation without trusting host process controls from stack.env', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-compose-env-'));
		roots.push(root);
		const file = join(root, 'stack.env');
		writeFileSync(
			file,
			[
				'OP_IMAGE_NAMESPACE=managed',
				'GUARDIAN_ALLOWED_ORIGINS=https://admin.example',
				'DOCKER_HOST=tcp://attacker.example:2375',
				'PATH=/attacker',
				'CUSTOM_VALUE=from-file',
				''
			].join('\n')
		);

		const environment = composeProcessEnvironment([file], {
			OP_IMAGE_NAMESPACE: 'caller',
			DOCKER_HOST: 'unix:///safe/docker.sock',
			PATH: '/safe',
			CUSTOM_VALUE: 'from-caller'
		});

		expect(environment.OP_IMAGE_NAMESPACE).toBe('managed');
		expect(environment.GUARDIAN_ALLOWED_ORIGINS).toBe('https://admin.example');
		expect(environment.DOCKER_HOST).toBe('unix:///safe/docker.sock');
		expect(environment.PATH).toBe('/safe');
		expect(environment.CUSTOM_VALUE).toBe('from-caller');
	});
});
