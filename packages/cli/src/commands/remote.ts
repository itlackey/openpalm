import { defineCommand } from 'citty';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
	beginRemoteEnable,
	disableRemote,
	remoteBrowserUrls,
	remoteTool,
	buildComposeCliArgs,
	createOpenPalmState,
	readStackConfig,
	requireInstall,
	runComposeStreaming
} from '@openpalm/lib';
import type { CodexSandbox } from '@openpalm/lib';

import { defineAction } from '../lib/action.js';
import { runStartAction } from './lifecycle.js';

export async function enableRemote(
	toolValue: unknown,
	options: { trust?: boolean; browser?: boolean; sandbox?: string } = {}
): Promise<void> {
	const tool = remoteTool(toolValue);
	if (options.sandbox !== undefined && !['workspace-write', 'read-only'].includes(options.sandbox))
		throw new Error('Choose workspace-write or read-only sandboxing.');
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			'Guided remote enable needs an interactive terminal. Use OpenPalm Admin for browser-based setup.'
		);
	const reader = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log(
			'This enables a separate native coding agent with trusted workspace and knowledge access, bypassing Guardian. Your OpenCode provider login is not reused.'
		);
		if (
			!options.trust &&
			!/^y(es)?$/i.test(
				(await reader.question('Continue with trusted native access? [y/N] ')).trim()
			)
		)
			return;
		console.log(
			'Follow the native sign-in prompts. Browser links open automatically when a desktop is available. Trust and consent require your answers; Ctrl+C cancels.'
		);
		const opened = new Set<string>();
		let displayed = '';
		let stage = '';
		const session = await beginRemoteEnable(createOpenPalmState(), tool, {
			trusted: true,
			sandbox: options.sandbox as CodexSandbox | undefined,
			update(progress) {
				if (progress.stage !== stage) {
					stage = progress.stage;
					console.log(`\nRemote setup: ${stage}`);
				}
				if (progress.output !== displayed) {
					process.stdout.write(
						progress.output.startsWith(displayed)
							? progress.output.slice(displayed.length)
							: progress.output
					);
					displayed = progress.output;
				}
				if (options.browser === false) return;
				for (const url of remoteBrowserUrls(progress.output)) {
					if (opened.has(url)) continue;
					opened.add(url);
					const [binary, ...args] =
						process.platform === 'darwin'
							? ['open', url]
							: process.platform === 'win32'
								? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
								: ['xdg-open', url];
					execFile(binary, args, { timeout: 10_000 }, (error) => {
						if (error) console.log('Open the native sign-in link above in your browser.');
					});
				}
			}
		});
		const input = (line: string) => {
			try {
				session.input(line);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		};
		const cancel = () => session.cancel();
		reader.on('line', input);
		reader.on('SIGINT', cancel);
		reader.on('close', cancel);
		try {
			const result = await session.done;
			if (result.error) throw new Error(result.error);
			console.log(
				`\n${tool} remote startup enabled. Pairing details are above; use a supported client and verify a real tool request. To refresh: openpalm remote pair ${tool}.`
			);
		} finally {
			reader.off('line', input);
			reader.off('SIGINT', cancel);
			reader.off('close', cancel);
		}
	} finally {
		reader.close();
	}
}

const enable = defineCommand({
	meta: {
		name: 'enable',
		description: 'Guide native sign-in, trust, sandbox checks, and remote startup'
	},
	args: {
		tool: { type: 'positional', required: true, description: 'codex or claude' },
		trust: {
			type: 'boolean',
			default: false,
			description: 'Confirm trusted native workspace access (vendor consent still required)'
		},
		browser: {
			type: 'boolean',
			default: true,
			description: 'Open native sign-in links (use --no-browser over SSH)'
		},
		sandbox: {
			type: 'string',
			description: 'Codex: workspace-write (default) or read-only; never bypasses sandboxing'
		}
	},
	run: defineAction(async ({ args }) =>
		enableRemote(args.tool, { trust: args.trust, browser: args.browser, sandbox: args.sandbox })
	)
});

const disable = defineCommand({
	meta: {
		name: 'disable',
		description: 'Stop native remote startup without removing account state'
	},
	args: { tool: { type: 'positional', required: true, description: 'codex or claude' } },
	run: defineAction(async ({ args }) => {
		await disableRemote(createOpenPalmState(), args.tool);
		console.log(
			'Remote startup disabled. Account state is retained; revoke devices through the vendor.'
		);
	})
});

export function remoteExecArguments(action: string, tool: string): string[] {
	if (tool !== 'codex' && tool !== 'claude') throw new Error('Choose codex or claude.');
	if (action === 'setup')
		return tool === 'codex' ? ['codex', 'login', '--device-auth'] : ['claude'];
	if (action === 'pair')
		return tool === 'codex'
			? ['codex', 'remote-control', 'pair', '--json']
			: ['openpalm-remote', 'claude', 'logs'];
	if (action === 'status') return ['openpalm-remote', tool, 'status'];
	if (action === 'logs') return ['openpalm-remote', tool, 'logs'];
	throw new Error('Choose setup, pair, status, or logs.');
}

function command(action: 'setup' | 'pair' | 'status' | 'logs') {
	return defineCommand({
		meta: {
			name: action,
			description: `${action} a vendor-native remote coding agent (not Guardian MCP)`
		},
		args: { tool: { type: 'positional', required: true, description: 'codex or claude' } },
		run: defineAction(async ({ args }) => {
			const tool = String(args.tool);
			const nativeArgs = remoteExecArguments(action, tool);
			const state = createOpenPalmState();
			requireInstall(state.homeDir);
			const parsed = readStackConfig(state.homeDir);
			if (!parsed.ok) throw new Error(parsed.error);
			const enabled =
				tool === 'codex'
					? parsed.config.assistant.codexRemote
					: parsed.config.assistant.claudeRemote;
			if (action === 'setup') {
				if (enabled)
					throw new Error(
						`Disable startup first: openpalm config assistant --${tool}-remote off. This avoids competing sign-in and background sessions.`
					);
				if (!process.stdin.isTTY || !process.stdout.isTTY)
					throw new Error(
						'Remote setup needs an interactive terminal for native sign-in and consent.'
					);
				console.log(
					'This grants trusted native workspace access, bypassing Guardian. Your OpenCode provider login is not reused.'
				);
				if (tool === 'claude')
					console.log(
						'In Claude Code: accept workspace trust, use /login with an eligible subscription, then /remote-control and approve its consent prompt. Use /exit when done. OpenPalm never accepts these prompts for you.'
					);
			} else if (!enabled && action === 'status') {
				console.log(JSON.stringify({ tool, state: 'disabled' }));
				return;
			} else if (!enabled)
				throw new Error(
					`Remote startup is disabled. Complete openpalm remote setup ${tool}, then openpalm config assistant --${tool}-remote on.`
				);
			await runStartAction();
			await runComposeStreaming(
				[
					...buildComposeCliArgs(state),
					'exec',
					...(action === 'setup' ? [] : ['-T']),
					'--workdir',
					'/work',
					'assistant',
					...nativeArgs
				],
				{ envFiles: [`${state.homeDir}/state/stack.env`] }
			);
			if (action === 'setup')
				console.log(`Enable startup when ready: openpalm config assistant --${tool}-remote on`);
			if (action === 'pair' || action === 'logs')
				console.log(
					'Treat pairing codes and connection links as private. A link or running process is not proof that your client has connected.'
				);
			if (action === 'status')
				console.log(
					'process-running reports the local process only, not vendor connection readiness. If waiting-to-retry, inspect openpalm remote logs ' +
						tool +
						' or repeat setup after disabling startup.'
				);
		})
	});
}

export default defineCommand({
	meta: {
		name: 'remote',
		description: 'Set up optional native Codex / Claude Code remote sessions'
	},
	subCommands: {
		enable,
		disable,
		setup: command('setup'),
		pair: command('pair'),
		status: command('status'),
		logs: command('logs')
	}
});
