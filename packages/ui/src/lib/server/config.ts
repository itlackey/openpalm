import { env } from '$env/dynamic/private';

export const PORT = Number(env.PORT ?? 8100);
export const ADMIN_TOKEN = env.ADMIN_TOKEN ?? 'change-me-admin-token';
export const DEFAULT_INSECURE_TOKEN = 'change-me-admin-token';

export const DATA_ROOT = env.OPENPALM_DATA_ROOT ?? '/data';
export const CONFIG_ROOT = env.OPENPALM_CONFIG_ROOT ?? '/config';
export const STATE_ROOT = env.OPENPALM_STATE_ROOT ?? '/state';

export const OPENCODE_CONFIG_PATH =
	env.OPENCODE_CONFIG_PATH ?? `${DATA_ROOT}/assistant/.config/opencode/opencode.json`;
export const DATA_DIR = env.DATA_DIR ?? `${DATA_ROOT}/admin`;
export const GATEWAY_URL = env.GATEWAY_URL ?? 'http://gateway:8080';
export const OPENCODE_CORE_URL = env.OPENCODE_CORE_URL ?? 'http://assistant:4096';
export const OPENMEMORY_URL = env.OPENMEMORY_URL ?? 'http://openmemory:8765';
export const RUNTIME_ENV_PATH = env.RUNTIME_ENV_PATH ?? `${STATE_ROOT}/.env`;
export const SECRETS_ENV_PATH = env.SECRETS_ENV_PATH ?? `${CONFIG_ROOT}/secrets.env`;
export const STACK_SPEC_PATH = env.STACK_SPEC_PATH ?? `${CONFIG_ROOT}/openpalm.yaml`;
export const COMPOSE_FILE_PATH =
	env.COMPOSE_FILE_PATH ?? `${STATE_ROOT}/rendered/docker-compose.yml`;
export const SYSTEM_ENV_PATH = env.SYSTEM_ENV_PATH ?? `${STATE_ROOT}/system.env`;
