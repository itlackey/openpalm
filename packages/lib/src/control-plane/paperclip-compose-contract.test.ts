import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';

const repoRoot = resolve(import.meta.dir, '../../../..');
const skeletonRoot = join(repoRoot, 'packages/skeleton');
const services = yamlParse(
	readFileSync(join(skeletonRoot, 'system/stack/services.compose.yml'), 'utf8')
) as {
	services?: Record<
		string,
		{
			profiles?: string[];
			image?: string;
			ports?: string[];
			volumes?: string[];
			networks?: string[];
			environment?: Record<string, string>;
			healthcheck?: { test?: string[] };
		}
	>;
};

const paperclipManagedOpenCodeDir = join(skeletonRoot, 'system/paperclip');
const paperclipUserOpenCodeDir = join(skeletonRoot, 'config/paperclip/opencode');

describe('Paperclip addon Compose contract', () => {
	test('uses one ordinary loopback-only addon service', () => {
		const paperclip = services.services?.paperclip;
		expect(paperclip?.profiles).toEqual(['addon.paperclip']);
		// The launchers below are verified against this exact upstream runtime.
		expect(paperclip?.image).toBe(
			'ghcr.io/paperclipai/paperclip:sha-59e29af@sha256:048034718f9922e3c1eb168f21c3fc6f4d3e1689ad7e1dd13322a331217d8457'
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

	test('mounts shared knowledge with Paperclip-specific env and secret overlays', () => {
		const paperclip = services.services?.paperclip;
		expect(paperclip?.volumes).toEqual([
			'${OP_HOME}/data/paperclip:/paperclip',
			'${OP_HOME}/config/paperclip/opencode:/paperclip/.config/opencode:ro',
			'${OP_HOME}/system/paperclip:/opt/openpalm/paperclip:ro',
			'${OP_HOME}/cache/paperclip-opencode/runtime:/etc/opencode',
			'${OP_HOME}/config/paperclip/akm:/etc/akm',
			'${OP_HOME}/knowledge:/stash',
			'${OP_HOME}/knowledge/paperclip/secrets:/stash/secrets',
			'${OP_HOME}/knowledge/paperclip/env:/stash/env',
			'${OP_HOME}/data/paperclip-akm/cache:/opt/akm/cache',
			'${OP_HOME}/data/paperclip-akm/data:/opt/akm/data'
		]);
		expect(paperclip?.volumes).not.toContain('${OP_HOME}/knowledge/secrets:/stash/secrets');
		expect(paperclip?.volumes).not.toContain('${OP_HOME}/knowledge/env:/stash/env');
	});

	test('passes one consistent OpenCode and AKM environment to every agent run', () => {
		const environment = services.services?.paperclip?.environment;
		expect(environment?.XDG_CONFIG_HOME).toBe('/paperclip/.config');
		expect(environment?.OPENCODE_CONFIG_DIR).toBe('/etc/opencode');
		expect(environment?.OPENCODE_STRICT_CONFIG_DEPS).toBe('1');
		expect(environment?.AKM_BUNDLE_DIR).toBe('/stash');
		expect(environment?.AKM_CONFIG_DIR).toBe('/etc/akm');
		expect(environment?.AKM_CACHE_DIR).toBe('/opt/akm/cache');
		expect(environment?.AKM_DATA_DIR).toBe('/opt/akm/data');
		expect(environment?.AKM_STATE_DIR).toBe('/opt/akm/data/state');
		expect(environment?.PATH).toBe(
			'/opt/openpalm/paperclip/bin:/etc/opencode/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/games:/usr/games'
		);
	});

	test('seeds an exact-pinned OpenCode plugin bootstrap without rebuilding Paperclip', () => {
		const manifest = JSON.parse(
			readFileSync(join(paperclipManagedOpenCodeDir, 'package.json'), 'utf8')
		) as {
			private?: boolean;
			dependencies?: Record<string, string>;
		};
		const assistantTools = JSON.parse(
			readFileSync(join(repoRoot, 'containers/assistant/tools/package.json'), 'utf8')
		) as { dependencies?: Record<string, string> };
		const assistantConfig = readFileSync(
			join(skeletonRoot, 'system/assistant/opencode.jsonc'),
			'utf8'
		);
		const assistantPluginVersion = assistantConfig.match(/akm-opencode@([^"']+)/)?.[1];

		expect(manifest.private).toBe(true);
		expect(manifest.dependencies).toEqual({
			'akm-cli': assistantTools.dependencies?.['akm-cli'],
			'akm-opencode': assistantPluginVersion
		});

		const pluginAdapter = readFileSync(join(paperclipManagedOpenCodeDir, 'plugins/akm.ts'), 'utf8');
		expect(pluginAdapter).toContain("import { AkmPlugin } from 'akm-opencode';");
		expect(pluginAdapter).toContain('export default AkmPlugin;');
		expect(pluginAdapter).not.toContain('export const');

		const bunLauncher = join(paperclipManagedOpenCodeDir, 'bin/bun');
		expect(readFileSync(bunLauncher, 'utf8')).toContain('BUN_BE_BUN=1');
		expect(statSync(bunLauncher).mode & 0o111).not.toBe(0);
		const openCodeLauncher = join(paperclipManagedOpenCodeDir, 'bin/opencode');
		const openCodeLauncherContents = readFileSync(openCodeLauncher, 'utf8');
		expect(openCodeLauncherContents).toContain('unset BETTER_AUTH_SECRET');
		expect(openCodeLauncherContents).toContain('unset PAPERCLIP_AGENT_JWT_SECRET');
		expect(openCodeLauncherContents).toContain(
			'unset PAPERCLIP_TOOL_ACTION_SIGNING_SECRET'
		);
		expect(openCodeLauncherContents).not.toContain('unset PAPERCLIP_API_KEY');
		expect(openCodeLauncherContents).toContain('flock 9');
		expect(openCodeLauncherContents).toContain(
			'timeout --kill-after=2s 15s /usr/local/bin/opencode debug config'
		);
		expect(openCodeLauncherContents).toContain(
			'timeout --kill-after=2s 15s env BUN_BE_BUN=1 /usr/local/bin/opencode -e'
		);
		expect(openCodeLauncherContents).toContain('Bun.spawnSync([process.argv[3], "--version"]');
		expect(openCodeLauncherContents).toContain('const hooks = await plugin.default({');
		expect(openCodeLauncherContents).toContain(
			'["akm_search", "akm_show", "akm_curate", "akm_feedback", "akm_remember"]'
		);
		expect(openCodeLauncherContents).toContain('temporary="${destination}.tmp.$$"');
		expect(openCodeLauncherContents).not.toContain('$runtime/bin');
		expect(openCodeLauncherContents).toContain(
			'.openpalm-bootstrap.lock|.openpalm-package.json|bun.lock|bun.lockb|node_modules|package.json'
		);
		// Published artifacts must never be transiently deleted (a sibling
		// launcher may have just released the flock) — they are only ever
		// atomically replaced by publish.
		expect(openCodeLauncherContents).toContain(
			'opencode.json|security.md) [ -f "$entry" ] && [ ! -L "$entry" ] || rm -rf -- "$entry" ;;'
		);
		expect(openCodeLauncherContents).toContain(
			'akm.ts) [ -f "$entry" ] && [ ! -L "$entry" ] || rm -rf -- "$entry" ;;'
		);
		expect(openCodeLauncherContents).toContain('*) rm -rf -- "$entry" ;;');
		expect(openCodeLauncherContents).toContain('$runtime/.openpalm-package.json');
		expect(openCodeLauncherContents).toContain(
			'runtime.dependencies?.[name] !== version || installed !== version'
		);
		expect(openCodeLauncherContents).toContain(
			'pluginVersion !== process.argv[3]'
		);
		expect(openCodeLauncherContents).toContain(
			'opencode_version=$(/usr/local/bin/opencode --version)'
		);
		expect(openCodeLauncherContents).toContain(
			'! dependencies_current "$managed/package.json"'
		);
		expect(
			openCodeLauncherContents.lastIndexOf(
				'publish "$managed/package.json" "$runtime/.openpalm-package.json"'
			)
		).toBeGreaterThan(openCodeLauncherContents.lastIndexOf('\nruntime_works\n'));
		expect(openCodeLauncherContents.indexOf('if [ -n "$bun_mode" ]')).toBeLessThan(
			openCodeLauncherContents.indexOf('flock 9')
		);
		expect(openCodeLauncherContents).toContain('exec /usr/local/bin/opencode "$@"');
		expect(statSync(openCodeLauncher).mode & 0o111).not.toBe(0);

		const config = JSON.parse(
			readFileSync(join(paperclipManagedOpenCodeDir, 'opencode.json'), 'utf8')
		) as {
			$schema?: string;
			share?: string;
			autoupdate?: boolean;
			instructions?: string[];
			plugin?: unknown;
			permission?: { external_directory?: Record<string, string> };
		};
		expect(config.$schema).toBe('https://opencode.ai/config.json');
		expect(config.share).toBe('disabled');
		expect(config.autoupdate).toBe(false);
		expect(config.instructions).toEqual(['/etc/opencode/security.md']);
		expect(config.plugin).toEqual(['file:///etc/opencode/plugins/akm.ts']);
		expect(readFileSync(join(paperclipManagedOpenCodeDir, 'security.md'), 'utf8')).toContain(
			'Never inspect, enumerate, print, or log process environment variables.'
		);
		expect(config.permission?.external_directory).toEqual({
			'/stash/*': 'allow',
			'/paperclip/instances/*/companies/*/agents/*/instructions/*': 'allow',
			'/paperclip/instances/*/workspaces/*/*': 'allow'
		});

		const userConfig = JSON.parse(
			readFileSync(join(paperclipUserOpenCodeDir, 'opencode.json'), 'utf8')
		) as Record<string, unknown>;
		expect(userConfig).toEqual({ $schema: 'https://opencode.ai/config.json' });

		const akmConfig = JSON.parse(
			readFileSync(join(skeletonRoot, 'config/paperclip/akm/config.json'), 'utf8')
		) as {
			configVersion?: string;
			defaults?: { engine?: string };
			engines?: Record<string, { kind?: string; platform?: string }>;
		};
		expect(akmConfig.configVersion).toBe('0.9.0');
		expect(akmConfig.defaults?.engine).toBe('opencode');
		expect(akmConfig.engines?.opencode).toEqual({ kind: 'agent', platform: 'opencode' });
	});
});
