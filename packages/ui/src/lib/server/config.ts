import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { resolve } from 'node:path';

function devDefault(envVar: string, dockerDefault: string, devRelative: string): string {
	const value = env[envVar];
	if (value) return value;
	if (dev) return resolve(devRelative);
	return dockerDefault;
}

export const ADMIN_TOKEN = env.ADMIN_TOKEN ?? 'change-me-admin-token';
export const DEFAULT_INSECURE_TOKEN = 'change-me-admin-token';

export const DATA_ROOT = devDefault('OPENPALM_DATA_ROOT', '/data', '../../.dev/data');
export const CONFIG_ROOT = devDefault('OPENPALM_CONFIG_ROOT', '/config', '../../.dev/config');
export const STATE_ROOT = devDefault('OPENPALM_STATE_ROOT', '/state', '../../.dev/state');

export const RUNTIME_ENV_PATH = `${STATE_ROOT}/.env`;
export const SECRETS_ENV_PATH = `${CONFIG_ROOT}/secrets.env`;
export const STACK_SPEC_PATH = `${CONFIG_ROOT}/openpalm.yaml`;
export const COMPOSE_FILE_PATH = `${STATE_ROOT}/docker-compose.yml`;
export const SYSTEM_ENV_PATH = `${STATE_ROOT}/system.env`;

export const DATA_ENV_PATH = `${DATA_ROOT}/.env`;
