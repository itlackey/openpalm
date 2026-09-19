import { defineCommand } from 'citty';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import {
	buildLeanComposeCliArgs,
	createLeanState,
	requireLeanInstall,
	runComposeStreaming
} from '@openpalm/lib/lean';

import { defineAction } from '../lib/action.js';
import { runStartAction } from './lifecycle-lean.js';

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function id(value: unknown): string {
	const parsed = String(value ?? '');
	if (!TASK_ID_RE.test(parsed)) {
		throw new Error('Task id must contain only letters, digits, dot, underscore, or dash.');
	}
	return parsed;
}

async function runTask(args: string[]): Promise<void> {
	const state = createLeanState();
	requireLeanInstall(state.homeDir);
	await runStartAction();
	await runComposeStreaming(
		[...buildLeanComposeCliArgs(state), 'exec', '-T', 'assistant', 'openpalm-task', ...args],
		{ envFiles: [`${state.homeDir}/state/stack.env`] }
	);
}

function positional(args: { _?: unknown[] }, index = 0): unknown {
	return args._?.[index];
}

const list = defineCommand({
	meta: { name: 'list', description: 'List recurring tasks' },
	args: { json: { type: 'boolean', description: 'print JSON' } },
	run: defineAction(async ({ args }) =>
		runTask(['list', ...(args.json ? ['--format', 'json'] : [])])
	)
});

const create = defineCommand({
	meta: { name: 'create', description: 'Create and schedule an autonomous prompt task' },
	args: {
		id: { type: 'positional', required: true, description: 'stable task id' },
		schedule: { type: 'string', required: true, description: 'cron schedule, such as 0 8 * * *' },
		prompt: { type: 'string', required: true, description: 'plain-language request' }
	},
	run: defineAction(async ({ args }) =>
		runTask([
			'create',
			id(positional(args)),
			'--schedule',
			String(args.schedule),
			'--prompt',
			String(args.prompt)
		])
	)
});

const show = defineCommand({
	meta: { name: 'show', description: 'Show one task definition' },
	args: { id: { type: 'positional', required: true, description: 'task id' } },
	run: defineAction(async ({ args }) => runTask(['show', id(positional(args))]))
});

function oneIdCommand(name: string, description: string) {
	return defineCommand({
		meta: { name, description },
		args: { id: { type: 'positional', required: true, description: 'task id' } },
		run: defineAction(async ({ args }) => runTask([name, id(positional(args))]))
	});
}

const pause = oneIdCommand('pause', 'Pause a task without deleting its history');
const resume = oneIdCommand('resume', 'Enable a paused task');
const run = oneIdCommand('run', 'Run a task now and retain its result');
const remove = oneIdCommand('remove', 'Unschedule a task and preserve its definition');

const history = defineCommand({
	meta: { name: 'history', description: 'Show durable task run history' },
	args: {
		id: { type: 'positional', required: false, description: 'optional task id' },
		limit: { type: 'string', description: 'maximum history entries' },
		json: { type: 'boolean', description: 'print JSON' }
	},
	run: defineAction(async ({ args }) => {
		const command = ['history'];
		if (positional(args)) command.push(id(positional(args)));
		if (args.limit) command.push('--limit', String(args.limit));
		if (args.json) command.push('--format', 'json');
		await runTask(command);
	})
});

const adopt = defineCommand({
	meta: { name: 'adopt', description: 'Validate and adopt one staged imported task in paused state' },
	args: { file: { type: 'positional', required: true, description: 'staged task file' } },
	run: defineAction(async ({ args }) => {
		const state = createLeanState();
		const stagedRoot = realpathSync(join(state.homeDir, 'knowledge', 'imported-tasks'));
		const requested = resolve(String(positional(args) ?? ''));
		if (!existsSync(requested) || !lstatSync(requested).isFile()) {
			throw new Error(`Staged task file not found: ${requested}`);
		}
		const source = realpathSync(requested);
		const path = relative(stagedRoot, source);
		if (path === '..' || path.startsWith(`..${sep}`) || path.includes(sep)) {
			throw new Error('Task adoption is limited to files directly under knowledge/imported-tasks.');
		}
		await runTask(['adopt', `/stash/imported-tasks/${basename(source)}`]);
	})
});

export default defineCommand({
	meta: { name: 'task', description: 'Create and manage durable recurring Assistant tasks' },
	subCommands: { list, create, show, pause, resume, run, history, remove, adopt }
});
