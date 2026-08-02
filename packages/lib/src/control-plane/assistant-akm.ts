import type { ControlPlaneState } from './types.js';
import { buildComposeOptions } from './compose-args.js';
import { composeExec } from './docker.js';

const ASSISTANT_AKM_BIN = '/usr/local/bin/akm';
const ASSISTANT_TASK_PATH =
	'/opt/openpalm/tools/node_modules/.bin:/usr/local/bin:/opt/assistant-tools/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/persistent/bin:/home/opencode/.local/bin:/home/opencode/.bun/bin';

export type AssistantAkmCommandResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	missing: boolean;
};

function looksMissing(stderr: string, exitCode: number): boolean {
	return (
		exitCode === 127 ||
		/executable file not found|\/usr\/local\/bin\/akm:?.*(?:no such file|not found)/i.test(stderr)
	);
}

function failureDetail(result: Awaited<ReturnType<typeof composeExec>>): string {
	return (
		result.stderr.trim() ||
		result.stdout.trim() ||
		(result.errorCode ? `Docker execution failed (${result.errorCode})` : '') ||
		`docker compose exec exited ${result.code}`
	);
}

function parsePrimaryGid(stdout: string): string | null {
	const value = stdout.trim();
	if (!/^[1-9][0-9]{0,9}$/.test(value)) return null;
	const gid = Number(value);
	if (!Number.isSafeInteger(gid) || gid > 2_147_483_647) return null;
	return String(gid);
}

export async function runAssistantAkmCommand(
	state: ControlPlaneState,
	args: string[],
	timeoutMs: number,
	options: { allowExitCodes?: number[] } = {},
	runCompose: typeof composeExec = composeExec
): Promise<AssistantAkmCommandResult> {
	const command = ['/usr/bin/env', `PATH=${ASSISTANT_TASK_PATH}`, ASSISTANT_AKM_BIN, ...args];
	// Container-wide NoNewPrivs suppresses Debian crontab's setgid transition.
	// Doctor therefore starts through the fixed root boundary and immediately
	// drops to node with only the supplementary crontab group. Task execution
	// remains a plain node process with no supplementary groups.
	const isTaskDoctor = args[0] === 'task' && args[1] === 'doctor';
	const composeOptions = { ...buildComposeOptions(state), timeoutMs };
	let primaryGid: string | null = null;
	if (isTaskDoctor) {
		let gidResult: Awaited<ReturnType<typeof composeExec>>;
		try {
			gidResult = await runCompose('assistant', ['/usr/bin/id', '-g', 'node'], {
				...composeOptions,
				user: 'root'
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				stdout: '',
				stderr: message,
				exitCode: 1,
				missing: looksMissing(message, 1)
			};
		}
		if (!gidResult.ok) {
			const detail = failureDetail(gidResult);
			return {
				ok: false,
				stdout: gidResult.stdout,
				stderr: detail,
				exitCode: gidResult.code,
				missing: looksMissing(detail, gidResult.code)
			};
		}
		primaryGid = parsePrimaryGid(gidResult.stdout);
		if (primaryGid === null) {
			return {
				ok: false,
				stdout: gidResult.stdout,
				stderr: 'Assistant node account has an invalid primary GID.',
				exitCode: 1,
				missing: false
			};
		}
	}
	const composeCommand = isTaskDoctor
		? [
				'/usr/bin/setpriv',
				'--reuid=node',
				`--regid=${primaryGid}`,
				'--groups=crontab',
				'--bounding-set=-all',
				'--inh-caps=-all',
				'--ambient-caps=-all',
				'--no-new-privs',
				'--',
				...command
			]
		: ['/usr/bin/setpriv', '--no-new-privs', '--', ...command];

	let result: Awaited<ReturnType<typeof composeExec>>;
	try {
		result = await runCompose('assistant', composeCommand, {
			...composeOptions,
			user: isTaskDoctor ? 'root' : 'node'
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			stdout: '',
			stderr: message,
			exitCode: 1,
			missing: looksMissing(message, 1)
		};
	}
	const allowed = (options.allowExitCodes ?? []).includes(result.code);
	const detail = result.ok || allowed ? result.stderr : failureDetail(result);

	return {
		ok: result.ok || allowed,
		stdout: result.stdout,
		stderr: detail,
		exitCode: result.code,
		missing: looksMissing(detail, result.code)
	};
}
