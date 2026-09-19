import { existsSync, lstatSync, readFileSync } from 'node:fs';

import { stateSecretFile, writeFileAtomic } from './lean-foundation.js';
import type { PortalName } from './portal-credential-store.js';

export type PortalSecretName = 'discord_bot_token' | 'slack_bot_token' | 'slack_app_token';

const SECRET_NAMES: Record<PortalName, readonly PortalSecretName[]> = {
	discord: ['discord_bot_token'],
	slack: ['slack_bot_token', 'slack_app_token']
};

export function portalSecretNames(portal: PortalName): readonly PortalSecretName[] {
	return SECRET_NAMES[portal];
}

export function normalizePortalSecret(value: string): string {
	const normalized = value.replace(/[\r\n]+$/, '');
	if (normalized.length < 8 || normalized.length > 4_096 || !/^[\x21-\x7e]+$/.test(normalized)) {
		throw new Error('Portal tokens must be 8–4096 printable non-whitespace ASCII characters.');
	}
	return normalized;
}

export function writePortalSecret(
	homeDir: string,
	portal: PortalName,
	name: PortalSecretName,
	value: string
): string {
	if (!SECRET_NAMES[portal].includes(name)) {
		throw new Error(`${name} is not a ${portal} secret`);
	}
	const path = stateSecretFile(homeDir, name);
	if (existsSync(path) && !lstatSync(path).isFile()) {
		throw new Error(`Refusing non-file portal secret path: ${path}`);
	}
	writeFileAtomic(path, `${normalizePortalSecret(value)}\n`, 0o600);
	return path;
}

export function portalSecretConfigured(
	homeDir: string,
	portal: PortalName
): Record<PortalSecretName, boolean> {
	const result = {} as Record<PortalSecretName, boolean>;
	for (const name of SECRET_NAMES[portal]) {
		const path = stateSecretFile(homeDir, name);
		result[name] =
			existsSync(path) && lstatSync(path).isFile() && readFileSync(path, 'utf8').trim().length > 0;
	}
	return result;
}
