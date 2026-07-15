import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const STACK_DIR = join(REPO_ROOT, 'packages/skeleton/system/stack');

type ComposeService = {
	environment?: Record<string, unknown>;
	healthcheck?: { test?: unknown };
	networks?: string[];
	ports?: unknown[];
	user?: string;
	volumes?: unknown[];
};

type ComposeDoc = { services?: Record<string, ComposeService> };

const core = yamlParse(readFileSync(join(STACK_DIR, 'core.compose.yml'), 'utf8')) as ComposeDoc;
const portals = yamlParse(
	readFileSync(join(STACK_DIR, 'portals.compose.yml'), 'utf8')
) as ComposeDoc;
const assistant = core.services?.assistant;
const guardian = portals.services?.guardian;

describe('assistant compose after container-client removal', () => {
	test('publishes only the OpenCode port', () => {
		const ports = (assistant?.ports ?? []).map(String);
		expect(ports).toEqual([
			'${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3800}:4096'
		]);
		expect(ports.join('\n')).not.toContain('OP_CLIENT_PORT');
		expect(ports.join('\n')).not.toMatch(/:3000$/m);
	});

	test('removes assistant-container client environment while preserving skeleton and host client CORS', () => {
		const environment = assistant?.environment ?? {};
		expect(Object.keys(environment).filter((key) => key.startsWith('OP_CLIENT_'))).toEqual([]);
		expect(environment.OP_SKELETON_VERSION).toBe('${OP_SKELETON_VERSION:-}');
		expect(environment.OP_HOST_CLIENT_PORT).toBe('${OP_HOST_CLIENT_PORT:-3890}');
	});

	test('healthcheck probes only OpenCode and keeps auth-aware credentials', () => {
		const healthcheck = String(assistant?.healthcheck?.test ?? []);
		expect(healthcheck).toContain('http://localhost:4096/health');
		expect(healthcheck).toContain('case "$${OPENCODE_AUTH:-false}"');
		expect(healthcheck).toContain('curl -sf -u "$${OPENCODE_SERVER_USERNAME:-opencode}:');
		expect(healthcheck).not.toContain('3000');
		expect(healthcheck).not.toContain('OP_CLIENT_PORT');
		expect(healthcheck).not.toContain('openpalm-client-skip');
	});

	test('artifact volume, rootless user, mounts, and assistant network remain intact', () => {
		expect(assistant?.user).toBe('${OP_UID:-1000}:${OP_GID:-1000}');
		expect(assistant?.networks).toContain('assistant_net');
		expect((assistant?.volumes ?? []).map(String)).toContain('assistant-artifacts:/opt/openpalm');
		expect((assistant?.volumes ?? []).map(String)).toContain('${OP_HOME}/workspace:/work');
	});
});

describe('guardian CORS after assistant-container client removal', () => {
	test('keeps only the host-served client defaults', () => {
		const value = String(guardian?.environment?.GUARDIAN_CORS_ALLOWED_ORIGINS ?? '');
		expect(value).toContain('OP_HOST_CLIENT_PORT:-3890');
		expect(value).not.toContain('OP_CLIENT_PORT');
		expect(value).not.toContain('3810');
		expect(value).not.toContain('*');
	});
});
