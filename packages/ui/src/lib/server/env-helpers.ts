import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SECRETS_ENV_PATH } from './config.ts';

const MAX_SECRETS_RAW_SIZE = 64 * 1024;

function ensureDir(path: string) {
	mkdirSync(dirname(path), { recursive: true });
}

function readOrEmpty(path: string): string {
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function readSecretsRaw(): string {
	return readOrEmpty(SECRETS_ENV_PATH);
}

export function writeSecretsRaw(content: string): void {
	ensureDir(SECRETS_ENV_PATH);
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
