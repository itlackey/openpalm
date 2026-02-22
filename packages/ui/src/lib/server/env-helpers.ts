import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
	parseRuntimeEnvContent,
	updateRuntimeEnvContent,
	setRuntimeBindScopeContent
} from '@openpalm/lib/admin/runtime-env';
import { RUNTIME_ENV_PATH, SECRETS_ENV_PATH } from './config.ts';

const MAX_SECRETS_RAW_SIZE = 64 * 1024;

export function readRuntimeEnv(): Record<string, string> {
	if (!existsSync(RUNTIME_ENV_PATH)) return {};
	return parseRuntimeEnvContent(readFileSync(RUNTIME_ENV_PATH, 'utf8'));
}

export function updateRuntimeEnv(entries: Record<string, string | undefined>) {
	const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, 'utf8') : '';
	const next = updateRuntimeEnvContent(current, entries);
	writeFileSync(RUNTIME_ENV_PATH, next, 'utf8');
}

export function setRuntimeBindScope(scope: 'host' | 'lan' | 'public') {
	const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, 'utf8') : '';
	const next = setRuntimeBindScopeContent(current, scope);
	writeFileSync(RUNTIME_ENV_PATH, next, 'utf8');
}

export function readSecretsEnv(): Record<string, string> {
	if (!existsSync(SECRETS_ENV_PATH)) return {};
	return parseRuntimeEnvContent(readFileSync(SECRETS_ENV_PATH, 'utf8'));
}

export function updateSecretsEnv(entries: Record<string, string | undefined>) {
	const current = existsSync(SECRETS_ENV_PATH) ? readFileSync(SECRETS_ENV_PATH, 'utf8') : '';
	const next = updateRuntimeEnvContent(current, entries);
	writeFileSync(SECRETS_ENV_PATH, next, 'utf8');
}

export function readSecretsRaw(): string {
	if (!existsSync(SECRETS_ENV_PATH)) return '';
	return readFileSync(SECRETS_ENV_PATH, 'utf8');
}

export function writeSecretsRaw(content: string) {
	writeFileSync(SECRETS_ENV_PATH, content, 'utf8');
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
