import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { readEnvFile } from './lean-foundation.js';

export type DockerResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
};

export type LeanComposeOptions = {
	files: string[];
	envFiles: string[];
	profiles: string[];
};

export type ComposePsRow = {
	service: string;
	state: string;
	health: string;
	id: string;
	exitCode: number | null;
};

function dockerBin(): string {
	return process.env.OP_DOCKER_BIN?.trim() || 'docker';
}

function stackEnvOverrides(files: string[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const path of files) Object.assign(values, readEnvFile(path));
	const allowed: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (/^(?:OP_|GUARDIAN_|DISCORD_|SLACK_)/.test(key)) allowed[key] = value;
	}
	return allowed;
}

/**
 * Keep Compose interpolation identical between preflight and activation while
 * refusing process-control variables (for example DOCKER_HOST or PATH) from
 * state/stack.env. Arbitrary custom variables still work through --env-file;
 * they simply cannot reconfigure the host process running Docker.
 */
export function composeProcessEnvironment(
	files: string[],
	parent: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	return { ...parent, ...stackEnvOverrides(files) };
}

function friendlyError(stderr: string): string {
	const value = stderr.trim();
	if (/\bENOENT\b|spawn\s+docker\s+.*not found/i.test(value)) {
		return 'Docker is not installed or is not on PATH.';
	}
	if (/permission denied/i.test(value))
		return 'Docker access was denied. Check daemon permissions.';
	if (/cannot connect|daemon is not running|connection refused/i.test(value)) {
		return 'Docker is stopped or unreachable.';
	}
	if (/address already in use|port is already allocated/i.test(value)) {
		return 'A configured port is already in use.';
	}
	return value.split(/\r?\n/).find(Boolean) || 'Docker command failed.';
}

export function runDocker(
	args: string[],
	options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<DockerResult> {
	return new Promise((resolve) => {
		execFile(
			dockerBin(),
			args,
			{
				timeout: options.timeoutMs ?? 120_000,
				env: { ...process.env, ...options.env }
			},
			(error, stdout, stderr) => {
				const detail = stderr?.toString() || (error ? String(error) : '');
				resolve({
					ok: !error,
					stdout: stdout?.toString() ?? '',
					stderr: detail,
					code:
						typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
							? Number((error as NodeJS.ErrnoException).code)
							: error
								? 1
								: 0
				});
			}
		);
	});
}

export async function ensureDockerReady(): Promise<{ ok: true } | { ok: false; message: string }> {
	const daemon = await runDocker(['info', '--format', '{{json .ServerVersion}}'], {
		timeoutMs: 10_000
	});
	if (!daemon.ok) return { ok: false, message: friendlyError(daemon.stderr) };
	const compose = await runDocker(['compose', 'version'], { timeoutMs: 10_000 });
	return compose.ok ? { ok: true } : { ok: false, message: friendlyError(compose.stderr) };
}

export function buildComposeArgs(options: LeanComposeOptions): string[] {
	const env = stackEnvOverrides(options.envFiles);
	const projectName = env.OP_PROJECT_NAME || process.env.OP_PROJECT_NAME || 'openpalm';
	const args = ['--project-name', projectName];
	for (const file of options.files) args.push('-f', file);
	for (const file of options.envFiles) {
		if (existsSync(file)) args.push('--env-file', file);
	}
	for (const profile of options.profiles) args.push('--profile', profile);
	return args;
}

export async function composePreflight(options: LeanComposeOptions): Promise<DockerResult> {
	return runDocker(['compose', ...buildComposeArgs(options), 'config', '--quiet'], {
		timeoutMs: 30_000,
		env: composeProcessEnvironment(options.envFiles)
	});
}

export async function composeConfigJson(
	options: LeanComposeOptions
): Promise<
	{ ok: true; config: unknown; stderr: '' } | { ok: false; config: null; stderr: string }
> {
	const result = await runDocker(
		['compose', ...buildComposeArgs(options), 'config', '--format', 'json'],
		{ timeoutMs: 30_000, env: composeProcessEnvironment(options.envFiles) }
	);
	if (!result.ok) return { ok: false, config: null, stderr: result.stderr };
	try {
		return { ok: true, config: JSON.parse(result.stdout) as unknown, stderr: '' };
	} catch (error) {
		return { ok: false, config: null, stderr: `Invalid Compose JSON: ${String(error)}` };
	}
}

export function runComposeStreaming(
	args: string[],
	options: { envFiles?: string[] } = {}
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(dockerBin(), ['compose', ...args], {
			stdio: ['inherit', 'inherit', 'pipe'],
			env: composeProcessEnvironment(options.envFiles ?? [])
		});
		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => {
			process.stderr.write(chunk);
			stderr = `${stderr}${chunk.toString('utf8')}`.slice(-32_000);
		});
		child.once('error', (error) => reject(new Error(friendlyError(String(error)))));
		child.once('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(friendlyError(stderr)));
		});
	});
}

export function parseComposePsRows(stdout: string): ComposePsRow[] {
	const rows: ComposePsRow[] = [];
	for (const line of stdout.trim().split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			const entries = Array.isArray(parsed) ? parsed : [parsed];
			for (const raw of entries) {
				if (!raw || typeof raw !== 'object') continue;
				const item = raw as Record<string, unknown>;
				const service = String(item.Service ?? item.Name ?? '');
				if (!service) continue;
				rows.push({
					service,
					state: String(item.State ?? ''),
					health: String(item.Health ?? ''),
					id: String(item.ID ?? ''),
					exitCode: typeof item.ExitCode === 'number' ? item.ExitCode : null
				});
			}
		} catch {
			// Ignore non-JSON progress emitted by older Compose releases.
		}
	}
	return rows;
}

export function composePs(options: LeanComposeOptions): Promise<DockerResult> {
	return runDocker(['compose', ...buildComposeArgs(options), 'ps', '-a', '--format', 'json'], {
		env: composeProcessEnvironment(options.envFiles)
	});
}

export function composeLogs(options: LeanComposeOptions, tail = 250): Promise<DockerResult> {
	return runDocker(['compose', ...buildComposeArgs(options), 'logs', '--tail', String(tail)], {
		env: composeProcessEnvironment(options.envFiles)
	});
}
