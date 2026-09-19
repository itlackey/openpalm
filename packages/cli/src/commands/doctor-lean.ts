import { defineCommand } from 'citty';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	auditLeanCompose,
	buildLeanComposeOptions,
	classifyLeanInstall,
	composeConfigJson,
	createLeanState,
	credentialKeyFile,
	credentialRegistryFile,
	ensureDockerReady,
	oauthConfigFile,
	oauthIdentityMapFile,
	portalCredentialBundleFile,
	portalCredentialMapFile,
	readStackConfig,
	requireLeanInstall,
	stateSecretFile,
	testAssistantReadiness
} from '@openpalm/lib/lean';

import { defineAction } from '../lib/action.js';

type Check = { name: string; ok: boolean; detail: string };

function fileCheck(
	name: string,
	path: string,
	requireContent = true,
	requirePrivate = true
): Check {
	if (!existsSync(path)) return { name, ok: false, detail: `missing: ${path}` };
	const stat = statSync(path);
	const privateMode = process.platform === 'win32' || (stat.mode & 0o077) === 0;
	const hasContent = !requireContent || stat.size > 0;
	return {
		name,
		ok: stat.isFile() && (!requirePrivate || privateMode) && hasContent,
		detail: `${path} (${stat.size} bytes, mode ${(stat.mode & 0o777).toString(8)})`
	};
}

function providerAuthCheck(path: string): Check {
	if (!existsSync(path)) return { name: 'provider sign-in', ok: false, detail: `missing: ${path}` };
	try {
		const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		const count =
			value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0;
		return {
			name: 'provider sign-in',
			ok: count > 0,
			detail:
				count > 0
					? `${count} provider credential(s) configured`
					: 'no provider credential configured'
		};
	} catch {
		return { name: 'provider sign-in', ok: false, detail: 'provider credential file is invalid' };
	}
}

export async function diagnoseLeanStack(
	options: { readiness?: boolean } = {}
): Promise<{ ok: boolean; checks: Check[] }> {
	const state = createLeanState();
	requireLeanInstall(state.homeDir);
	const checks: Check[] = [];
	checks.push({
		name: 'setup completion',
		ok: classifyLeanInstall(state.homeDir) === 'installed',
		detail:
			classifyLeanInstall(state.homeDir) === 'installed'
				? 'provider readiness was verified'
				: 'incomplete; run `openpalm setup` or `openpalm provider test`'
	});
	const config = readStackConfig(state.homeDir);
	checks.push({
		name: 'stack config',
		ok: config.ok,
		detail: config.ok ? `${state.homeDir}/state/stack.json` : config.error
	});

	const docker = await ensureDockerReady();
	checks.push({ name: 'docker', ok: docker.ok, detail: docker.ok ? 'ready' : docker.message });
	checks.push(
		fileCheck('OpenCode password', stateSecretFile(state.homeDir, 'op_opencode_password')),
		fileCheck('Guardian handle key', stateSecretFile(state.homeDir, 'op_guardian_handle_key')),
		fileCheck('Guardian OAuth config', oauthConfigFile(state.homeDir)),
		fileCheck('Guardian OAuth identity map', oauthIdentityMapFile(state.homeDir)),
		fileCheck(
			'provider credentials',
			join(state.homeDir, 'knowledge', 'secrets', 'auth.json'),
			false
		),
		providerAuthCheck(join(state.homeDir, 'knowledge', 'secrets', 'auth.json')),
		fileCheck(
			'scheduled task engine',
			join(state.homeDir, 'config', 'akm', 'config.json'),
			true,
			false
		),
		fileCheck(
			'scheduled agent profile',
			join(state.homeDir, 'system', 'assistant', 'agents', 'scheduled.md'),
			true,
			false
		)
	);
	if (config.ok) {
		checks.push(fileCheck('credential registry', credentialRegistryFile(state.homeDir)));
		for (const username of Object.keys(config.config.credentials)) {
			checks.push(fileCheck(`credential ${username}`, credentialKeyFile(state.homeDir, username)));
		}
		for (const portal of ['discord', 'slack'] as const) {
			checks.push(
				fileCheck(`${portal} credential map`, portalCredentialMapFile(state.homeDir, portal)),
				fileCheck(`${portal} credential bundle`, portalCredentialBundleFile(state.homeDir, portal))
			);
		}
	}

	if (config.ok && config.config.portals.discord.enabled) {
		checks.push(
			fileCheck('Discord bot token', stateSecretFile(state.homeDir, 'discord_bot_token'))
		);
	}
	if (config.ok && config.config.portals.slack.enabled) {
		checks.push(
			fileCheck('Slack bot token', stateSecretFile(state.homeDir, 'slack_bot_token')),
			fileCheck('Slack app token', stateSecretFile(state.homeDir, 'slack_app_token'))
		);
	}

	if (docker.ok) {
		const compose = await composeConfigJson(buildLeanComposeOptions(state));
		checks.push({
			name: 'compose config',
			ok: compose.ok,
			detail: compose.ok ? 'valid' : compose.stderr || 'validation failed'
		});
		if (compose.ok) {
			const issues = auditLeanCompose(compose.config, state.homeDir);
			checks.push({
				name: 'compose security boundaries',
				ok: issues.length === 0,
				detail: issues.length === 0 ? 'valid' : issues.join('; ')
			});
		}
		if (options.readiness) {
			const readiness = await testAssistantReadiness(state.homeDir, { timeoutMs: 120_000 });
			checks.push({
				name: 'live provider readiness',
				ok: readiness.ok,
				detail: readiness.ok
					? `${readiness.provider ?? 'provider'}${readiness.model ? `/${readiness.model}` : ''} responded`
					: readiness.error
			});
		}
	}
	return { ok: checks.every((check) => check.ok), checks };
}

export default defineCommand({
	meta: { name: 'doctor', description: 'Check lean stack configuration, credentials, and Docker' },
	args: {
		json: { type: 'boolean', description: 'Print machine-readable JSON', default: false },
		readiness: {
			type: 'boolean',
			description: 'send a small real model request (may incur provider usage)',
			default: false
		}
	},
	run: defineAction(async ({ args }) => {
		const result = await diagnoseLeanStack({ readiness: args.readiness === true });
		if (args.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			for (const check of result.checks) {
				console.log(`${check.ok ? 'ok' : 'FAIL'}  ${check.name}: ${check.detail}`);
			}
		}
		if (!result.ok) throw new Error('One or more checks failed.');
	})
});
