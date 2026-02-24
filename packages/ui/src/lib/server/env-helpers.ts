import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
	parseRuntimeEnvContent,
	updateRuntimeEnvContent,
	setRuntimeBindScopeContent
} from '@openpalm/lib/admin/runtime-env';
import { dirname } from 'node:path';
import { DATA_ENV_PATH, RUNTIME_ENV_PATH, SECRETS_ENV_PATH } from './config.ts';

const MAX_SECRETS_RAW_SIZE = 64 * 1024;

/**
 * Simple async mutex keyed by file path. Ensures read-modify-write sequences
 * for env files are serialized, preventing data loss from concurrent writes.
 */
const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const existing = fileLocks.get(path) ?? Promise.resolve();
	let resolve: () => void;
	const next = new Promise<void>((r) => {
		resolve = r;
	});
	fileLocks.set(path, next);
	await existing;
	try {
		return await fn();
	} finally {
		resolve!();
	}
}

export function readRuntimeEnv(): Record<string, string> {
	if (!existsSync(RUNTIME_ENV_PATH)) return {};
	return parseRuntimeEnvContent(readFileSync(RUNTIME_ENV_PATH, 'utf8'));
}

export function updateRuntimeEnv(entries: Record<string, string | undefined>) {
	// Wrap in file lock to prevent concurrent read-modify-write races.
	// Using void return since callers treat this as sync-like (fire and forget lock).
	void withFileLock(RUNTIME_ENV_PATH, async () => {
		const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, 'utf8') : '';
		const next = updateRuntimeEnvContent(current, entries);
		mkdirSync(dirname(RUNTIME_ENV_PATH), { recursive: true });
		writeFileSync(RUNTIME_ENV_PATH, next, 'utf8');
	});
}

export function setRuntimeBindScope(scope: 'host' | 'lan' | 'public') {
	void withFileLock(RUNTIME_ENV_PATH, async () => {
		const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, 'utf8') : '';
		const next = setRuntimeBindScopeContent(current, scope);
		mkdirSync(dirname(RUNTIME_ENV_PATH), { recursive: true });
		writeFileSync(RUNTIME_ENV_PATH, next, 'utf8');
	});
}

export function readSecretsEnv(): Record<string, string> {
	if (!existsSync(SECRETS_ENV_PATH)) return {};
	return parseRuntimeEnvContent(readFileSync(SECRETS_ENV_PATH, 'utf8'));
}

export function updateSecretsEnv(entries: Record<string, string | undefined>) {
	void withFileLock(SECRETS_ENV_PATH, async () => {
		const current = existsSync(SECRETS_ENV_PATH) ? readFileSync(SECRETS_ENV_PATH, 'utf8') : '';
		const next = updateRuntimeEnvContent(current, entries);
		mkdirSync(dirname(SECRETS_ENV_PATH), { recursive: true });
		writeFileSync(SECRETS_ENV_PATH, next, 'utf8');
	});
}

export function readSecretsRaw(): string {
	if (!existsSync(SECRETS_ENV_PATH)) return '';
	return readFileSync(SECRETS_ENV_PATH, 'utf8');
}

export function writeSecretsRaw(content: string) {
	void withFileLock(SECRETS_ENV_PATH, async () => {
		mkdirSync(dirname(SECRETS_ENV_PATH), { recursive: true });
		writeFileSync(SECRETS_ENV_PATH, content, 'utf8');
	});
}

export function validateSecretsRawContent(content: string): string | null {
	if (content.length > MAX_SECRETS_RAW_SIZE) return 'content exceeds maximum size (64 KB)';
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		if (!trimmed.includes('='))
			return `invalid env line (missing '='): ${trimmed.slice(0, 40)}`;
		const key = trimmed.split('=')[0].trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `invalid env key: ${key.slice(0, 40)}`;
	}
	return null;
}

export function readDataEnv(): Record<string, string> {
	if (!existsSync(DATA_ENV_PATH)) return {};
	return parseRuntimeEnvContent(readFileSync(DATA_ENV_PATH, 'utf8'));
}

export function updateDataEnv(entries: Record<string, string | undefined>) {
	void withFileLock(DATA_ENV_PATH, async () => {
		const current = existsSync(DATA_ENV_PATH) ? readFileSync(DATA_ENV_PATH, 'utf8') : '';
		const next = updateRuntimeEnvContent(current, entries);
		mkdirSync(dirname(DATA_ENV_PATH), { recursive: true });
		writeFileSync(DATA_ENV_PATH, next, 'utf8');
	});
}
