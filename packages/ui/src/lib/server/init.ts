import { building } from '$app/environment';
import { createLogger } from '@openpalm/lib/shared/logger.ts';
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

export { CoreSecretRequirements } from '@openpalm/lib/admin/stack-manager';

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
			secretsEnvPath: SECRETS_ENV_PATH,
			stackSpecPath: STACK_SPEC_PATH,
			runtimeEnvPath: RUNTIME_ENV_PATH,
			systemEnvPath: SYSTEM_ENV_PATH,
			dataEnvPath: DATA_ENV_PATH,
			composeFilePath: COMPOSE_FILE_PATH,
		});
	}
	return _stackManager;
}

export async function ensureInitialized(): Promise<void> {
	if (_initialized || building) return;
	_initialized = true;

	if (ADMIN_TOKEN === DEFAULT_INSECURE_TOKEN) {
		log.warn(
			'Default admin token detected. Set ADMIN_TOKEN environment variable before exposing to network.'
		);
	}
}

export async function knownServices(): Promise<Set<string>> {
	const { allowedServiceSet, filterUiManagedServices } = await import('@openpalm/lib/admin/compose-runner');
	const sm = await getStackManager();
	const base = await allowedServiceSet();
	for (const name of sm.listChannelNames()) base.add(`channel-${name}`);
	return new Set(filterUiManagedServices(Array.from(base)));
}
