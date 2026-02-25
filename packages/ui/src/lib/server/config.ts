import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { resolve } from 'node:path';

/**
 * Resolve a config value: explicit env var > dev-mode .dev/ path > Docker default.
 * In dev mode (vite dev), paths resolve relative to packages/ui/ into ../../.dev/.
 */
function devDefault(envVar: string, dockerDefault: string, devRelative: string): string {
	const value = env[envVar];
	if (value) return value;
	if (dev) return resolve(devRelative);
	return dockerDefault;
}

export const PORT = Number(env.PORT ?? 8100);
export const ADMIN_TOKEN = env.ADMIN_TOKEN ?? 'change-me-admin-token';
export const DEFAULT_INSECURE_TOKEN = 'change-me-admin-token';

export const DATA_ROOT = devDefault('OPENPALM_DATA_ROOT', '/data', '../../.dev/data');
export const CONFIG_ROOT = devDefault('OPENPALM_CONFIG_ROOT', '/config', '../../.dev/config');
export const STATE_ROOT = devDefault('OPENPALM_STATE_ROOT', '/state', '../../.dev/state');

export const OPENCODE_CONFIG_PATH =
	env.OPENCODE_CONFIG_PATH ?? `${DATA_ROOT}/assistant/.config/opencode/opencode.json`;
export const DATA_DIR = env.DATA_DIR ?? `${DATA_ROOT}/admin`;
export const GATEWAY_URL = devDefault('GATEWAY_URL', 'http://gateway:8080', 'http://localhost:8080');
export const OPENPALM_ASSISTANT_URL = devDefault(
	'OPENPALM_ASSISTANT_URL',
	'http://assistant:4096',
	'http://localhost:4096'
);
export const OPENMEMORY_URL = devDefault(
	'OPENMEMORY_URL',
	'http://openmemory:8765',
	'http://localhost:8765'
);
export const RUNTIME_ENV_PATH = `${STATE_ROOT}/.env`;
export const SECRETS_ENV_PATH = `${CONFIG_ROOT}/secrets.env`;
export const STACK_SPEC_PATH = `${CONFIG_ROOT}/openpalm.yaml`;
export const COMPOSE_FILE_PATH = `${STATE_ROOT}/docker-compose.yml`;
export const SYSTEM_ENV_PATH = `${STATE_ROOT}/system.env`;
export const CRON_DIR = dev
	? resolve('../../.dev/state/automations')
	: '/state/automations';

export const DATA_ENV_PATH = `${DATA_ROOT}/.env`;
