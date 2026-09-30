import { defineCommand } from 'citty';
import {
	buildComposeCliArgs,
	createOpenPalmState,
	readStackConfig,
	requireInstall,
	runComposeStreaming
} from '@openpalm/lib';

import { defineAction } from '../lib/action.js';
import { runStartAction } from './lifecycle.js';

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
		setup: command('setup'),
		pair: command('pair'),
		status: command('status'),
		logs: command('logs')
	}
});
