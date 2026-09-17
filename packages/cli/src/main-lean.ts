#!/usr/bin/env bun

import { defineCommand, runCommand } from 'citty';
import { readFileSync } from 'node:fs';
import {
	classifyLeanInstall,
	readStackConfig,
	resolveOpenPalmHome,
	stateSecretFile
} from '@openpalm/lib/lean';

import cliPackage from '../package.json' with { type: 'json' };

function assistantEndpoint(homeDir: string): string {
	const result = readStackConfig(homeDir);
	const bindAddress = result.ok ? result.config.assistant.bindAddress : '127.0.0.1';
	const port = result.ok ? result.config.assistant.port : 3810;
	const dialAddress =
		bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress === '::' ? '::1' : bindAddress;
	const host = dialAddress.includes(':') ? `[${dialAddress}]` : dialAddress;
	return `http://${host}:${port}`;
}

async function assistantHealthy(): Promise<boolean> {
	const homeDir = resolveOpenPalmHome();
	try {
		const password = readFileSync(stateSecretFile(homeDir, 'op_opencode_password'), 'utf8').trim();
		if (!password) return false;
		const authorization = Buffer.from(`opencode:${password}`, 'utf8').toString('base64');
		const response = await fetch(`${assistantEndpoint(homeDir)}/config`, {
			headers: { authorization: `Basic ${authorization}` },
			signal: AbortSignal.timeout(1_500)
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function autoRun(): Promise<void> {
	const homeDir = resolveOpenPalmHome();
	const installState = classifyLeanInstall(homeDir);
	if (installState === 'not_installed') {
		const { bootstrapLeanInstall } = await import('./commands/install-lean.js');
		await bootstrapLeanInstall({ start: true });
		return;
	}
	if (installState === 'setup_incomplete') {
		const { updateLeanStack } = await import('./commands/update-lean.js');
		await updateLeanStack({ start: true });
		return;
	}

	if (!(await assistantHealthy())) {
		const { runStartAction } = await import('./commands/lifecycle-lean.js');
		await runStartAction();
	}

	const config = readStackConfig(homeDir);
	console.log('OpenPalm Assistant is running.');
	console.log(`Native OpenCode: ${assistantEndpoint(homeDir)}`);
	if (config.ok && config.config.gateway.enabled) {
		console.log(
			`Guardian MCP: http://${config.config.gateway.bindAddress}:${config.config.gateway.port}/mcp`
		);
	}
}

const subCommands = {
	install: () => import('./commands/install-lean.js').then((module) => module.default),
	update: () => import('./commands/update-lean.js').then((module) => module.default),
	addon: () => import('./commands/addon-lean.js').then((module) => module.default),
	credential: () => import('./commands/credential-lean.js').then((module) => module.default),
	config: () => import('./commands/config-lean.js').then((module) => module.default),
	doctor: () => import('./commands/doctor-lean.js').then((module) => module.default),
	start: () => import('./commands/lifecycle-lean.js').then((module) => module.startCommand),
	stop: () => import('./commands/lifecycle-lean.js').then((module) => module.stopCommand),
	restart: () => import('./commands/lifecycle-lean.js').then((module) => module.restartCommand),
	logs: () => import('./commands/lifecycle-lean.js').then((module) => module.logsCommand),
	status: () => import('./commands/lifecycle-lean.js').then((module) => module.statusCommand)
} as const;

const COMMAND_USAGE: Readonly<Record<string, string>> = {
	install: 'openpalm install [--no-start] [--config <stack.json>]',
	update: 'openpalm update [--no-start]',
	addon: 'openpalm addon list | enable <gateway|discord|slack> | disable <name>',
	credential:
		'openpalm credential list | add <username> <chat|read|full> [--key-file <path>] [--show-key] | show <username> [--show-key] | set-policy <username> <chat|read|full> | rotate <username> [--key-file <path>] [--show-key] | remove <username> | map <discord|slack> <user-id> <username> | unmap <discord|slack> <user-id> | mappings <discord|slack>',
	config:
		'openpalm config show | path | assistant [--bind <ip>] [--port <port>] | gateway [--bind <ip>] [--port <port>] | portal <discord|slack> --credential <username>',
	doctor: 'openpalm doctor [--json]',
	start: 'openpalm start',
	stop: 'openpalm stop',
	restart: 'openpalm restart',
	logs: 'openpalm logs',
	status: 'openpalm status'
};

export function helpText(command?: string): string {
	if (command) {
		const usage = COMMAND_USAGE[command];
		if (!usage) throw new Error(`Unknown command: ${command}`);
		return `Usage: ${usage}\n`;
	}
	return [
		'OpenPalm — manage a lean, self-hosted agent',
		'',
		'Usage: openpalm <command> [options]',
		'',
		'Commands:',
		...Object.entries(COMMAND_USAGE).map(([name, usage]) =>
			`  ${name.padEnd(9)} ${usage.replace(/^openpalm\s+\S+\s*/, '')}`.trimEnd()
		),
		'',
		'Run `openpalm help <command>` for command usage.',
		'Run `openpalm --version` for the installed version.'
	].join('\n');
}

export const mainCommand = defineCommand({
	meta: {
		name: 'openpalm',
		version: cliPackage.version,
		description: 'Manage a lean, self-hosted OpenPalm agent'
	},
	subCommands
});

const commandNames = new Set([...Object.keys(subCommands), '--help', '-h', 'help']);

export async function main(argv = process.argv.slice(2)): Promise<void> {
	if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
		console.log(cliPackage.version);
		return;
	}
	if (argv[0] === '--help' || argv[0] === '-h') {
		console.log(helpText());
		return;
	}
	if (argv[0] === 'help') {
		console.log(helpText(argv[1]));
		return;
	}
	if (argv[1] === '--help' || argv[1] === '-h') {
		console.log(helpText(argv[0]));
		return;
	}
	if (argv.length === 0) {
		await autoRun();
		return;
	}
	if (!commandNames.has(argv[0] ?? '')) {
		throw new Error(`Unknown command: ${argv[0]}. Run \`openpalm --help\` for available commands.`);
	}
	await runCommand(mainCommand, { rawArgs: argv });
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
