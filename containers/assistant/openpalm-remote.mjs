#!/usr/bin/env -S bun --no-env-file
// Optional vendor-native agents. Their failures never stop OpenCode or cron.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const remoteDirectory = '/tmp/openpalm-runtime/remote';
export function remoteCommand(
	tool,
	sandbox = process.env.OPENPALM_CODEX_SANDBOX ?? 'workspace-write'
) {
	if (!['workspace-write', 'read-only'].includes(sandbox)) throw new Error('Invalid Codex sandbox');
	if (tool === 'codex')
		return [
			'codex',
			'remote-control',
			'-c',
			'approval_policy="on-request"',
			'-c',
			`sandbox_mode="${sandbox}"`
		];
	if (tool === 'claude')
		return [
			'claude',
			'remote-control',
			'--spawn',
			'same-dir',
			'--capacity',
			'1',
			'--permission-mode',
			'default',
			'--no-chrome'
		];
	throw new Error('Remote agent must be codex or claude.');
}

export function remoteEnvironment(source) {
	const env = { ...source };
	// Native sessions use their own account sign-in, never the Assistant API password.
	for (const key of Object.keys(env)) {
		if (/^(OPENCODE_|GUARDIAN_|PORTAL_|DISCORD_|SLACK_|OPENPALM_)/.test(key)) delete env[key];
	}
	// Remote sessions require native account sign-in, not ambient provider keys.
	for (const key of [
		'OPENAI_API_KEY',
		'ANTHROPIC_API_KEY',
		'CODEX_API_KEY',
		'CLAUDE_CODE_OAUTH_TOKEN'
	])
		delete env[key];
	// Suppress vendor self-updates: runtime software is release-pinned and image-baked.
	env.DISABLE_AUTOUPDATER = '1';
	return env;
}

export async function superviseRemote(
	tool,
	{ directory = remoteDirectory, retryMs = 300_000, env = process.env, workdir = '/work' } = {}
) {
	const [binary, ...args] = remoteCommand(tool);
	process.umask(0o077);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const statusFile = join(directory, `${tool}.json`);
	const logFile = join(directory, `${tool}.log`);
	let child;
	let stopping = false;
	let wake;
	let timer;
	let childDeadline;
	let groupForced = false;
	let log = Buffer.alloc(0);
	const status = (state, details = {}) => {
		writeFileSync(`${statusFile}.tmp`, JSON.stringify({ tool, state, ...details }), {
			mode: 0o600
		});
		chmodSync(`${statusFile}.tmp`, 0o600);
		renameSync(`${statusFile}.tmp`, statusFile);
	};
	const record = (chunk) => {
		// Pairing links can be sensitive. Keep bounded output in a private file,
		// never in Docker logs or the scheduler's durable history.
		log = Buffer.concat([log, Buffer.from(chunk)]).subarray(-65_536);
		writeFileSync(logFile, log, { mode: 0o600 });
		chmodSync(logFile, 0o600);
	};
	const stop = () => {
		stopping = true;
		clearTimeout(timer);
		wake?.();
		if (child?.pid) {
			const pid = child.pid;
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				/* already stopped */
			}
			// A wedged vendor process must not delay Assistant shutdown indefinitely.
			timer = setTimeout(() => {
				groupForced = true;
				try {
					process.kill(-pid, 'SIGKILL');
				} catch {
					/* already stopped */
				}
			}, 3_000);
		}
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	try {
		while (!stopping) {
			groupForced = false;
			log = Buffer.alloc(0);
			record('');
			const code = await new Promise((resolve) => {
				child = spawn(binary, args, {
					cwd: workdir,
					env: remoteEnvironment(env),
					detached: true,
					stdio: ['ignore', 'pipe', 'pipe']
				});
				child.stdout.on('data', record);
				child.stderr.on('data', record);
				child.on('spawn', () => status('process-running', { pid: child.pid }));
				child.on('error', () => resolve(127));
				child.on('exit', () => {
					const pid = child.pid;
					try {
						process.kill(-pid, 'SIGTERM');
					} catch {
						return;
					}
					// Descendants may keep stdout open after their leader exits;
					// waiting for close alone would hang instead of retrying.
					childDeadline = setTimeout(() => {
						groupForced = true;
						try {
							process.kill(-pid, 'SIGKILL');
						} catch {
							/* reaped */
						}
					}, 3_000);
				});
				child.on('close', (exitCode) => resolve(exitCode ?? 1));
			});
			// The leader can exit before its session children. Do not cancel the
			// shutdown deadline or start another attempt while descendants survive.
			if (child?.pid) {
				let groupExists = false;
				try {
					process.kill(-child.pid, 0);
					groupExists = true;
				} catch {
					/* reaped */
				}
				if (groupExists) {
					if (!groupForced) await new Promise((resolve) => setTimeout(resolve, 3_000));
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch {
						/* reaped */
					}
				}
			}
			clearTimeout(childDeadline);
			if (!stopping) {
				status('waiting-to-retry', {
					exitCode: code,
					retryAt: new Date(Date.now() + retryMs).toISOString()
				});
				await new Promise((resolve) => {
					wake = resolve;
					timer = setTimeout(resolve, retryMs);
				});
			}
		}
	} finally {
		clearTimeout(timer);
		clearTimeout(childDeadline);
		process.off('SIGTERM', stop);
		process.off('SIGINT', stop);
		status('stopped');
	}
}

if (import.meta.main) {
	const [tool, action] = process.argv.slice(2);
	remoteCommand(tool);
	if (action === 'status' || action === 'logs') {
		try {
			process.stdout.write(
				`${readFileSync(join(remoteDirectory, `${tool}.${action === 'status' ? 'json' : 'log'}`), 'utf8')}\n`
			);
		} catch {
			console.log(
				action === 'status'
					? JSON.stringify({ tool, state: 'not-started' })
					: 'No remote output. Enable startup and check status first.'
			);
		}
	} else if (action === undefined) {
		await superviseRemote(tool);
	} else throw new Error('Use status or logs, or omit the action to run remote control.');
}
