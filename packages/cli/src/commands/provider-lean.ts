import { defineCommand } from 'citty';
import { readFileSync } from 'node:fs';
import {
	buildLeanComposeCliArgs,
	createLeanState,
	ensureDockerReady,
	listProviders,
	markLeanInstalled,
	removeProviderAuth,
	requireLeanInstall,
	runComposeStreaming,
	setProviderApiKey,
	testAssistantReadiness,
	waitForAssistant
} from '@openpalm/lib/lean';

import { defineAction } from '../lib/action.js';
import { runStartAction } from './lifecycle-lean.js';

function readKey(path: string): string {
	const value = readFileSync(path === '-' ? 0 : path, 'utf8').replace(/[\r\n]+$/, '');
	if (!value) throw new Error('Provider key is empty');
	if (/[\r\n]/.test(value)) throw new Error('Provider key must be one line');
	return value;
}

export async function runNativeProviderLogin(options: {
	provider?: string;
	method?: string;
}): Promise<void> {
	const state = createLeanState();
	requireLeanInstall(state.homeDir);
	const docker = await ensureDockerReady();
	if (!docker.ok) throw new Error(docker.message);
	await runStartAction();
	await waitForAssistant(state.homeDir);
	const args = [
		...buildLeanComposeCliArgs(state),
		'exec',
		'assistant',
		'opencode',
		'auth',
		'login'
	];
	if (options.provider) args.push('--provider', options.provider);
	if (options.method) args.push('--method', options.method);
	await runComposeStreaming(args, { envFiles: [`${state.homeDir}/state/stack.env`] });
}

async function verifyAndComplete(homeDir: string): Promise<void> {
	const readiness = await testAssistantReadiness(homeDir);
	if (!readiness.ok) throw new Error(`Provider readiness failed: ${readiness.error}`);
	markLeanInstalled(homeDir);
	console.log(
		`Provider ready${readiness.provider ? `: ${readiness.provider}` : ''}${readiness.model ? `/${readiness.model}` : ''}.`
	);
}

const listCommand = defineCommand({
	meta: { name: 'list', description: 'List providers and authentication methods from OpenCode' },
	args: { json: { type: 'boolean', default: false, description: 'Print JSON' } },
	run: defineAction(async ({ args }) => {
		const state = createLeanState();
		requireLeanInstall(state.homeDir);
		await runStartAction();
		await waitForAssistant(state.homeDir, { timeoutMs: 5_000 });
		const providers = (await listProviders(state.homeDir)).filter(
			(provider) =>
				provider.authMethods.length > 0 || provider.authenticated || provider.connected
		);
		if (args.json) {
			console.log(JSON.stringify(providers, null, 2));
			return;
		}
		if (providers.length === 0) {
			console.log('No sign-in providers were reported by OpenCode.');
			return;
		}
		for (const provider of providers) {
			const status = provider.authenticated || provider.connected ? 'ready' : 'not signed in';
			const methods = provider.authMethods.map((method) => method.label).join(', ') || 'configured';
			console.log(`${provider.id.padEnd(24)} ${status.padEnd(14)} ${methods}`);
		}
	})
});

const loginCommand = defineCommand({
	meta: { name: 'login', description: "Run OpenCode's native provider sign-in flow" },
	args: {
		provider: { type: 'positional', required: false, description: 'Provider id or name' },
		method: { type: 'string', description: 'OpenCode login method label' }
	},
	run: defineAction(async ({ args }) => {
		await runNativeProviderLogin({
			provider: args.provider ? String(args.provider) : undefined,
			method: args.method ? String(args.method) : undefined
		});
		await verifyAndComplete(createLeanState().homeDir);
	})
});

const keyCommand = defineCommand({
	meta: { name: 'key', description: 'Store a provider API key through OpenCode' },
	args: {
		provider: { type: 'positional', required: true, description: 'Provider id' },
		'key-file': {
			type: 'string',
			required: true,
			description: 'Read the key from this file, or - for stdin'
		}
	},
	run: defineAction(async ({ args }) => {
		const state = createLeanState();
		requireLeanInstall(state.homeDir);
		await runStartAction();
		await waitForAssistant(state.homeDir);
		await setProviderApiKey(state.homeDir, String(args.provider), readKey(String(args['key-file'])));
		await verifyAndComplete(state.homeDir);
	})
});

const logoutCommand = defineCommand({
	meta: { name: 'logout', description: 'Remove one provider credential through OpenCode' },
	args: { provider: { type: 'positional', required: true, description: 'Provider id' } },
	run: defineAction(async ({ args }) => {
		const state = createLeanState();
		requireLeanInstall(state.homeDir);
		await runStartAction();
		await waitForAssistant(state.homeDir, { timeoutMs: 5_000 });
		await removeProviderAuth(state.homeDir, String(args.provider));
		console.log(`Removed provider credential: ${String(args.provider)}`);
	})
});

const testCommand = defineCommand({
	meta: { name: 'test', description: 'Run a real no-tool Assistant readiness request' },
	run: defineAction(async () => {
		const state = createLeanState();
		requireLeanInstall(state.homeDir);
		await runStartAction();
		await waitForAssistant(state.homeDir);
		await verifyAndComplete(state.homeDir);
	})
});

export default defineCommand({
	meta: { name: 'provider', description: 'Sign in to and verify OpenCode model providers' },
	subCommands: {
		list: listCommand,
		login: loginCommand,
		key: keyCommand,
		logout: logoutCommand,
		test: testCommand
	}
});
