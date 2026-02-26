import { building } from '$app/environment';
import { createLogger } from './logger';
import {
	DATA_ROOT,
	CONFIG_ROOT,
	STATE_ROOT,
	SECRETS_ENV_PATH,
	STACK_SPEC_PATH,
	SYSTEM_ENV_PATH,
	COMPOSE_FILE_PATH,
	RUNTIME_ENV_PATH,
	DATA_ENV_PATH,
	ADMIN_TOKEN,
	DEFAULT_INSECURE_TOKEN
} from './config';

export const log = createLogger('admin');

// Re-export type for route convenience (this import is type-only so safe at build time)
export { CoreSecretRequirements } from '@openpalm/lib/admin/stack-manager';

// --- Lazy singletons: avoid side-effects during SvelteKit build analysis ---
// All heavy @openpalm/lib imports are deferred via dynamic import() to prevent
// module-level Bun.env reads and filesystem operations during build.

type StackManager = import('@openpalm/lib/admin/stack-manager').StackManager;

let _stackManager: StackManager | undefined;
let _initialized = false;

export async function getStackManager(): Promise<StackManager> {
	if (!_stackManager) {
		const { StackManager } = await import('@openpalm/lib/admin/stack-manager');
		_stackManager = new StackManager({
			stateRootPath: STATE_ROOT,
			dataRootPath: DATA_ROOT,
			configRootPath: CONFIG_ROOT,
			caddyJsonPath: `${STATE_ROOT}/caddy.json`,
			secretsEnvPath: SECRETS_ENV_PATH,
			stackSpecPath: STACK_SPEC_PATH,
			runtimeEnvPath: RUNTIME_ENV_PATH,
			systemEnvPath: SYSTEM_ENV_PATH,
			gatewayEnvPath: `${STATE_ROOT}/gateway/.env`,
			openmemoryEnvPath: `${STATE_ROOT}/openmemory/.env`,
			postgresEnvPath: `${STATE_ROOT}/postgres/.env`,
			qdrantEnvPath: `${STATE_ROOT}/qdrant/.env`,
			assistantEnvPath: `${STATE_ROOT}/assistant/.env`,
			dataEnvPath: DATA_ENV_PATH,
			composeFilePath: COMPOSE_FILE_PATH,
		});
	}
	return _stackManager;
}

/** Run one-time startup logic. Safe to call multiple times. No-op during build. */
export async function ensureInitialized(): Promise<void> {
	if (_initialized || building) return;
	_initialized = true;

	if (ADMIN_TOKEN === DEFAULT_INSECURE_TOKEN) {
		log.warn(
			'Default admin token detected. Set ADMIN_TOKEN environment variable before exposing to network.'
		);
	}
}

// Helper functions used by routes
export async function allChannelServiceNames(): Promise<string[]> {
	const sm = await getStackManager();
	return sm.listChannelNames().map((name) => `channel-${name}`);
}

export async function allServiceNames(): Promise<string[]> {
	const sm = await getStackManager();
	return sm.listServiceNames().map((name) => `service-${name}`);
}

export async function knownServices(): Promise<Set<string>> {
	const { allowedServiceSet, filterUiManagedServices } = await import('@openpalm/lib/admin/compose-runner');
	const base = await allowedServiceSet();
	for (const svc of await allChannelServiceNames()) base.add(svc);
	for (const svc of await allServiceNames()) base.add(svc);
	return new Set(filterUiManagedServices(Array.from(base)));
}
