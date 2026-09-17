import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type LeanState = {
	homeDir: string;
	configDir: string;
	knowledgeDir: string;
	workspaceDir: string;
	dataDir: string;
	stackDir: string;
};

export function resolveOpenPalmHome(): string {
	const requested = process.env.OP_HOME?.trim();
	const path = resolve(requested || join(homedir() || tmpdir(), '.openpalm'));
	let existing = path;
	const missing: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		missing.unshift(basename(existing));
		existing = parent;
	}
	return resolve(realpathSync(existing), ...missing);
}

export function createLeanState(): LeanState {
	const homeDir = resolveOpenPalmHome();
	return {
		homeDir,
		configDir: join(homeDir, 'config'),
		knowledgeDir: join(homeDir, 'knowledge'),
		workspaceDir: join(homeDir, 'workspace'),
		dataDir: join(homeDir, 'data'),
		stackDir: join(homeDir, 'system', 'stack')
	};
}

export function stackConfigFile(homeDir: string): string {
	return join(homeDir, 'state', 'stack.json');
}

export function stackEnvFile(homeDir: string): string {
	return join(homeDir, 'state', 'stack.env');
}

export function managedComposeFile(homeDir: string): string {
	return join(homeDir, 'system', 'stack', 'stack.compose.yml');
}

export function customComposeFile(homeDir: string): string {
	return join(homeDir, 'config', 'stack', 'custom.compose.yml');
}

export function stateSecretFile(homeDir: string, name: string): string {
	if (!/^[a-z0-9][a-z0-9_]{0,80}$/.test(name)) throw new Error(`Invalid secret name: ${name}`);
	return join(homeDir, 'state', 'secrets', name);
}

const REQUIRED_DIRS = [
	'config/assistant',
	'config/guardian',
	'config/akm',
	'config/portal/discord',
	'config/portal/slack',
	'config/stack',
	'data/assistant',
	'data/assistant/.cache/opencode',
	'data/assistant/.config/opencode',
	'data/assistant/.local/share/opencode',
	'data/assistant/.local/state/opencode',
	'data/akm/cache',
	'data/akm/data',
	'data/portal/discord',
	'data/portal/slack',
	'data/logs',
	'knowledge/env',
	'knowledge/secrets',
	'knowledge/tasks',
	'state/credentials',
	'state/portal-credentials/discord',
	'state/portal-credentials/slack',
	'state/secrets',
	'system/assistant',
	'system/guardian',
	'system/stack',
	'workspace'
] as const;

export function ensureLeanDirs(homeDir: string): void {
	mkdirSync(homeDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	if (!lstatSync(homeDir).isDirectory()) throw new Error(`OP_HOME is not a directory: ${homeDir}`);
	chmodSync(homeDir, PRIVATE_DIR_MODE);
	for (const relative of REQUIRED_DIRS) {
		let current = homeDir;
		for (const segment of relative.split('/')) {
			current = join(current, segment);
			if (!existsSync(current)) mkdirSync(current, { mode: PRIVATE_DIR_MODE });
			if (!lstatSync(current).isDirectory()) {
				throw new Error(`Refusing non-directory or symlink in OP_HOME: ${current}`);
			}
			chmodSync(current, PRIVATE_DIR_MODE);
		}
	}
}

export function writeFileAtomic(path: string, content: string, mode = PRIVATE_FILE_MODE): void {
	mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
	const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
	try {
		writeFileSync(temporary, content, { encoding: 'utf8', mode });
		renameSync(temporary, path);
		chmodSync(path, mode);
	} catch (error) {
		try {
			if (existsSync(temporary)) renameSync(temporary, `${temporary}.failed`);
		} catch {
			// Preserve the original error; the failed temporary file is harmless.
		}
		throw error;
	}
}

function decodeEnvValue(raw: string): string {
	const value = raw.trim();
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value
			.slice(1, -1)
			.replace(/\\n/g, '\n')
			.replace(/\\r/g, '\r')
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, '\\');
	}
	const comment = value.search(/\s+#/);
	return comment < 0 ? value : value.slice(0, comment).trimEnd();
}

export function parseEnvContent(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const sourceLine of content.split(/\r?\n/)) {
		let line = sourceLine.trim();
		if (!line || line.startsWith('#')) continue;
		if (line.startsWith('export ')) line = line.slice(7).trimStart();
		const separator = line.indexOf('=');
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		result[key] = decodeEnvValue(line.slice(separator + 1));
	}
	return result;
}

export function readEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	return parseEnvContent(readFileSync(path, 'utf8'));
}

function encodeEnvValue(key: string, value: string): string {
	if (/^[A-Za-z0-9_./,:+-]*$/.test(value)) return value;
	if (/[\n\r']/.test(value)) throw new Error(`Cannot store ${key} safely in stack.env`);
	return `'${value}'`;
}

export function mergeEnvContent(content: string, updates: Record<string, string>): string {
	const pending = new Map(Object.entries(updates));
	const lines = content.split(/\r?\n/);
	const output = lines.map((sourceLine) => {
		let candidate = sourceLine.trimStart();
		const prefix = candidate.startsWith('export ') ? 'export ' : '';
		if (prefix) candidate = candidate.slice(prefix.length).trimStart();
		const separator = candidate.indexOf('=');
		if (separator <= 0) return sourceLine;
		const key = candidate.slice(0, separator).trim();
		const value = pending.get(key);
		if (value === undefined) return sourceLine;
		pending.delete(key);
		return `${key}=${encodeEnvValue(key, value)}`;
	});
	while (output.length > 0 && output.at(-1) === '') output.pop();
	for (const [key, value] of pending) output.push(`${key}=${encodeEnvValue(key, value)}`);
	return `${output.join('\n')}\n`;
}

export function updateEnvFile(path: string, updates: Record<string, string>): void {
	const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
	writeFileAtomic(path, mergeEnvContent(current, updates));
}
