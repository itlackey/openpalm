#!/usr/bin/env -S bun --no-env-file
// Private stdio bridge to native prompts, not a network service or auth format.
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { remoteCommand, remoteEnvironment } from './openpalm-remote.mjs';

export function setupCommands(tool, sandbox) {
	if (!['workspace-write', 'read-only'].includes(sandbox)) throw new Error('Invalid sandbox mode');
	if (tool === 'codex')
		return [
			['sandbox', ['codex', '-c', `sandbox_mode="${sandbox}"`, 'sandbox', '/usr/bin/true']],
			['sign-in', ['codex', 'login', '--device-auth']],
			['account', ['codex', 'login', 'status']]
		];
	if (tool === 'claude')
		return [
			['sign-in', ['claude', 'auth', 'login', '--claudeai']],
			['trust-and-consent', remoteCommand('claude')]
		];
	throw new Error('Choose codex or claude');
}

export async function guidedSetup(
	tool,
	sandbox,
	{
		env = process.env,
		workdir = '/work',
		emit = (value) => console.log(JSON.stringify(value)),
		input = process.stdin,
		timeoutMs = 900_000
	} = {}
) {
	const commands = setupCommands(tool, sandbox);
	let child;
	let cancelled = false;
	let stopping;
	const stopChild = () => {
		if (!child) return;
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			/* exited */
		}
		clearTimeout(stopping);
		const pid = child.pid;
		stopping = setTimeout(() => {
			try {
				process.kill(-pid, 'SIGKILL');
			} catch {
				/* exited */
			}
		}, 2000);
	};
	const cancel = () => {
		cancelled = true;
		stopChild();
	};
	const reader = createInterface({ input });
	reader.on('line', (line) => {
		try {
			const request = JSON.parse(line);
			if (request.cancel === true) cancel();
			else if (
				typeof request.input === 'string' &&
				request.input.length <= 2048 &&
				![...request.input].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
			)
				child?.terminal.write(`${request.input}\r`);
		} catch {
			cancel();
		}
	});
	reader.on('close', cancel);
	process.on('SIGTERM', cancel);
	process.on('SIGINT', cancel);
	const deadline = setTimeout(cancel, timeoutMs);
	try {
		for (const [stage, args] of commands) {
			if (cancelled) throw new Error('Setup cancelled or expired; remote access remains off.');
			if (stage === 'sign-in') {
				const account = Bun.spawnSync(
					tool === 'claude' ? ['claude', 'auth', 'status'] : ['codex', 'login', 'status'],
					{
						cwd: workdir,
						env: remoteEnvironment(env),
						stdin: 'ignore',
						stdout: 'pipe',
						stderr: 'pipe',
						timeout: 5000
					}
				);
				let signedIn = false;
				if (account.exitCode === 0) {
					if (tool === 'codex') signedIn = /chatgpt/i.test(`${account.stdout}${account.stderr}`);
					else {
						try {
							signedIn = JSON.parse(account.stdout.toString()).loggedIn === true;
						} catch {
							/* native status unavailable */
						}
					}
				}
				if (signedIn) {
					emit({
						output: 'Existing native account sign-in found; checking remote prerequisites.\n'
					});
					continue;
				}
			}
			emit({ stage });
			let output = '';
			let connected = false;
			child = Bun.spawn(args, {
				cwd: workdir,
				env: { ...remoteEnvironment(env), TERM: 'dumb' },
				terminal: {
					cols: 4096,
					rows: 32,
					data(_terminal, data) {
						const text = stripVTControlCharacters(Buffer.from(data).toString('utf8'));
						output = `${output}${text}`.slice(-65_536);
						// The setup server is temporary; only the final background link
						// should be offered to the browser after activation.
						emit({
							replace: stage === 'trust-and-consent',
							output:
								stage === 'trust-and-consent'
									? output.replace(
											/https:\/\/claude\.(?:ai|com)\/code\/[^\s]+/g,
											'[Native registration confirmed; final connection follows after startup]'
										)
									: text
						});
						if (
							stage === 'trust-and-consent' &&
							/https:\/\/claude\.(?:ai|com)\/code\/[^\s]+(?=\s)/.test(output)
						) {
							connected = true;
							stopChild();
						}
					}
				}
			});
			const code = await child.exited;
			child.terminal.close();
			stopChild();
			child = undefined;
			if (cancelled) throw new Error('Setup cancelled or expired; remote access remains off.');
			if (code !== 0 && !connected) {
				if (stage === 'sandbox')
					throw new Error(
						'Codex sandbox check failed. This host/container must support bubblewrap namespaces. OpenPalm has not disabled sandboxing or changed host security. Remote access remains off.'
					);
				throw new Error(
					`Native ${stage} failed. Review the native output above; remote access remains off.`
				);
			}
			if (stage === 'account' && !/chatgpt/i.test(output))
				throw new Error('Codex remote access requires ChatGPT account sign-in, not an API key.');
			if (stage === 'trust-and-consent' && !connected)
				throw new Error(
					'Claude did not confirm a Remote Control connection. Remote access remains off.'
				);
		}
		emit({ ready: true });
	} finally {
		clearTimeout(deadline);
		stopChild();
		if (stopping) await new Promise((resolve) => setTimeout(resolve, 2100));
		clearTimeout(stopping);
		reader.removeListener('close', cancel);
		reader.close();
		process.off('SIGTERM', cancel);
		process.off('SIGINT', cancel);
	}
}

if (import.meta.main) {
	try {
		await guidedSetup(process.argv[2], process.argv[3] ?? 'workspace-write');
	} catch (error) {
		console.log(JSON.stringify({ error: error.message }));
		process.exitCode = 1;
	}
}
