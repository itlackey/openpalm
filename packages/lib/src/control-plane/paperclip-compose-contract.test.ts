import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';

const repoRoot = resolve(import.meta.dir, '../../../..');
const services = yamlParse(
	readFileSync(join(repoRoot, 'packages/skeleton/system/stack/services.compose.yml'), 'utf8')
) as {
	services?: Record<
		string,
		{
			profiles?: string[];
			image?: string;
			ports?: string[];
			networks?: string[];
			environment?: Record<string, string>;
			healthcheck?: { test?: string[] };
		}
	>;
};

describe('Paperclip addon Compose contract', () => {
	test('uses one ordinary loopback-only addon service', () => {
		const paperclip = services.services?.paperclip;
		expect(paperclip?.profiles).toEqual(['addon.paperclip']);
		expect(paperclip?.image).toBe(
			'${OP_IMAGE_NAMESPACE:-openpalm}/paperclip:${OP_PAPERCLIP_VERSION:-2026.722.0}'
		);
		expect(paperclip?.ports).toEqual(['127.0.0.1:${OP_PAPERCLIP_PORT:-3840}:3100']);
		// Network segmentation is owned by addon-network-boundary.test.ts (the
		// canonical S.6b sweep, which now includes paperclip) — not re-asserted here.
		expect(services.services?.['paperclip-db']).toBeUndefined();
	});

	test('keeps upstream authentication, privacy, telemetry, and health settings explicit', () => {
		const paperclip = services.services?.paperclip;
		expect(paperclip?.environment?.PAPERCLIP_DEPLOYMENT_MODE).toBe('authenticated');
		expect(paperclip?.environment?.PAPERCLIP_DEPLOYMENT_EXPOSURE).toBe('private');
		// Operator-controllable via OP_TELEMETRY_DISABLED, but the interpolation
		// default must stay "1": an install predating the key, or a hand-run
		// `docker compose`, must get telemetry OFF. The unset case is never the
		// permissive one.
		expect(paperclip?.environment?.PAPERCLIP_TELEMETRY_DISABLED).toBe(
			'${OP_TELEMETRY_DISABLED:-1}'
		);
		expect(paperclip?.environment?.DO_NOT_TRACK).toBe('${OP_TELEMETRY_DISABLED:-1}');
		expect(paperclip?.healthcheck?.test).toEqual([
			'CMD',
			'curl',
			'-fsS',
			'http://127.0.0.1:3100/api/health'
		]);
	});
});
