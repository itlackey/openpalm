/**
 * Manages a dedicated OpenCode subprocess for OAuth flows.
 *
 * The assistant container's OpenCode instance is not on the host network,
 * so OAuth callbacks that redirect to localhost need a separate OpenCode
 * process running on the admin's loopback. This module spawns one lazily
 * and reuses it across requests.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, symlinkSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

type AuthServerState = {
	baseUrl?: string;
	ready?: Promise<string>;
	homeDir?: string;
	process?: {
		kill(signal?: string): void;
		exitCode: number | null;
		on(event: 'exit', listener: () => void): void;
	};
};

const globalState = globalThis as typeof globalThis & { __ocpAuthServer?: AuthServerState };

function state() {
	globalState.__ocpAuthServer ??= {};
	return globalState.__ocpAuthServer;
}

export async function ensureAuthServer() {
	const current = state();
	if (current.baseUrl && current.process?.exitCode === null) return current.baseUrl;
	if (current.ready) return current.ready;

	current.ready = startServer();
	return current.ready;
}

export function getAuthServerBaseUrl() {
	return state().baseUrl;
}

async function startServer() {
	const port = await getFreePort();
	const homeDir = createWizardStyleHome();
	const proc = spawn('opencode', ['web', '--hostname', '127.0.0.1', '--port', String(port)], {
		stdio: 'ignore',
		env: {
			...process.env,
			HOME: homeDir
		}
	});

	const current = state();
	current.process = proc as AuthServerState['process'];
	current.baseUrl = `http://127.0.0.1:${port}`;
	current.homeDir = homeDir;

	proc.on('exit', () => {
		if (state().process === proc) {
			cleanupHomeDir(state().homeDir);
			state().baseUrl = undefined;
			state().homeDir = undefined;
			state().process = undefined;
			state().ready = undefined;
		}
	});

	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${current.baseUrl}/provider`, {
				signal: AbortSignal.timeout(2_000)
			});

			if (response.ok) {
				current.ready = undefined;
				return current.baseUrl;
			}
		} catch {
			// wait for server
		}

		await new Promise((resolve) => setTimeout(resolve, 300));
	}

	proc.kill('SIGTERM');
	cleanupHomeDir(current.homeDir);
	current.ready = undefined;
	current.baseUrl = undefined;
	current.homeDir = undefined;
	current.process = undefined;
	throw new Error('Timed out starting dedicated OpenCode auth server.');
}

function createWizardStyleHome() {
	const homeDir = mkdtempSync(join(tmpdir(), 'ocp-auth-'));
	const home = homedir();
	const shareDir = join(homeDir, '.local', 'share', 'opencode');
	const configDir = join(homeDir, '.config', 'opencode');
	const stateDir = join(homeDir, '.local', 'state', 'opencode');

	mkdirSync(shareDir, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });

	const authSrc = join(home, '.local/share/opencode', 'auth.json');
	const authDst = join(shareDir, 'auth.json');
	if (existsSync(authSrc) && !existsSync(authDst)) {
		symlinkSync(authSrc, authDst);
	}

	const configSrc = join(home, '.config/opencode', 'opencode.json');
	const configDst = join(configDir, 'opencode.json');
	if (existsSync(configSrc) && !existsSync(configDst)) {
		copyFileSync(configSrc, configDst);
	}

	return homeDir;
}

function cleanupHomeDir(homeDir?: string) {
	if (!homeDir) return;
	try {
		rmSync(homeDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
}

async function getFreePort() {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Unable to allocate auth server port.'));
				return;
			}

			const { port } = address;
			server.close(() => resolve(port));
		});
		server.on('error', reject);
	});
}
