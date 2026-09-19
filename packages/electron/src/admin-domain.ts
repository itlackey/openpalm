import {
	applyLeanHomeSeed,
	applyLeanImport,
	acquireLeanLock,
	classifyLeanInstall,
	createCredentialId,
	createLeanBackup,
	createLeanState,
	defaultStackConfig,
	ensureCredentialKeys,
	ensureLeanDirs,
	ensureLeanRuntime,
	ensureOAuthFiles,
	generateCredentialKey,
	isCredentialUsername,
	isGuardianPolicy,
	isPortalName,
	isPortalUserId,
	oauthCredentialUsages,
	planLeanImport,
	portalCredentialUsages,
	readPortalCredentialMap,
	readStackConfig,
	removeCredentialKey,
	releaseLeanLock,
	syncPortalCredentialBundles,
	writeCredentialKey,
	writePortalCredentialMap,
	writeStackConfig,
	type GuardianPolicy,
	type PortalName,
	type StackConfig
} from '@openpalm/lib/lean';

export async function installFromAdmin(): Promise<string> {
	const state = createLeanState();
	if (classifyLeanInstall(state.homeDir) !== 'not_installed') {
		throw new Error('OpenPalm is already installed or the selected home is not empty.');
	}
	ensureLeanDirs(state.homeDir);
	await applyLeanHomeSeed(state.homeDir);
	writeStackConfig(state.homeDir, defaultStackConfig());
	ensureLeanRuntime(state);
	return state.homeDir;
}

export function saveAdminConfig(homeDir: string, config: StackConfig): StackConfig {
	const saved = writeStackConfig(homeDir, config);
	ensureCredentialKeys(homeDir, saved);
	ensureOAuthFiles(homeDir);
	syncPortalCredentialBundles(homeDir, saved);
	return saved;
}

function current(homeDir: string): StackConfig {
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	ensureCredentialKeys(homeDir, result.config);
	ensureOAuthFiles(homeDir);
	return result.config;
}

function username(value: unknown): string {
	if (!isCredentialUsername(value)) throw new Error('Invalid credential username.');
	return value;
}

function policy(value: unknown): GuardianPolicy {
	if (!isGuardianPolicy(value)) throw new Error('Policy must be chat, read, or full.');
	return value;
}

export function createAdminCredential(
	homeDir: string,
	value: { username: unknown; policy: unknown }
): { username: string; policy: GuardianPolicy; keyFile: string } {
	const name = username(value.username);
	const selectedPolicy = policy(value.policy);
	const config = current(homeDir);
	if (Object.hasOwn(config.credentials, name))
		throw new Error(`Credential already exists: ${name}`);
	if (Object.keys(config.credentials).length >= 128) throw new Error('Credential limit reached.');
	const key = generateCredentialKey();
	const keyFile = writeCredentialKey(homeDir, name, key);
	config.credentials[name] = { id: createCredentialId(), policy: selectedPolicy };
	writeStackConfig(homeDir, config);
	syncPortalCredentialBundles(homeDir, config);
	return { username: name, policy: selectedPolicy, keyFile };
}

export function rotateAdminCredential(homeDir: string, value: unknown): string {
	const name = username(value);
	const config = current(homeDir);
	if (!Object.hasOwn(config.credentials, name)) throw new Error(`Unknown credential: ${name}`);
	const keyFile = writeCredentialKey(homeDir, name, generateCredentialKey());
	syncPortalCredentialBundles(homeDir, config);
	return keyFile;
}

export function removeAdminCredential(homeDir: string, value: unknown): void {
	const name = username(value);
	const config = current(homeDir);
	if (!Object.hasOwn(config.credentials, name)) throw new Error(`Unknown credential: ${name}`);
	const usages = [
		...portalCredentialUsages(homeDir, config, name),
		...oauthCredentialUsages(homeDir, name)
	];
	if (usages.length > 0) throw new Error(`Credential is assigned to ${usages.join(', ')}.`);
	if (Object.keys(config.credentials).length === 1)
		throw new Error('Cannot remove the final credential.');
	delete config.credentials[name];
	writeStackConfig(homeDir, config);
	removeCredentialKey(homeDir, name);
}

export function mapAdminPortalUser(
	homeDir: string,
	value: { portal: unknown; userId: unknown; username?: unknown }
): void {
	if (!isPortalName(value.portal)) throw new Error('Portal must be discord or slack.');
	const portal: PortalName = value.portal;
	if (!isPortalUserId(portal, value.userId)) throw new Error(`Invalid ${portal} user ID.`);
	const config = current(homeDir);
	const mapping = readPortalCredentialMap(homeDir, portal);
	if (value.username === undefined || value.username === '') {
		delete mapping.users[value.userId];
	} else {
		const name = username(value.username);
		if (!Object.hasOwn(config.credentials, name)) throw new Error(`Unknown credential: ${name}`);
		mapping.users[value.userId] = name;
	}
	writePortalCredentialMap(homeDir, portal, mapping);
	syncPortalCredentialBundles(homeDir, config);
}

export function adminPortalMappings(homeDir: string) {
	const config = current(homeDir);
	return Object.fromEntries(
		(['discord', 'slack'] as const).map((portal) => [
			portal,
			{
				default: config.portals[portal].credential,
				users: readPortalCredentialMap(homeDir, portal).users
			}
		])
	);
}

export async function backupFromAdmin(
	homeDir: string,
	value: {
		destination: string;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}
) {
	return createLeanBackup({ sourceHome: homeDir, ...value });
}

export function importFromAdmin(
	homeDir: string,
	value: {
		sourceHome: string;
		apply?: boolean;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}
) {
	if (classifyLeanInstall(homeDir) !== 'setup_incomplete') {
		throw new Error('Import is available only before setup is completed on a fresh installation.');
	}
	const options = { destinationHome: homeDir, ...value };
	if (!value.apply) return planLeanImport(options);
	const state = createLeanState();
	if (state.homeDir !== homeDir) throw new Error('Admin import destination changed unexpectedly.');
	const lock = acquireLeanLock(state.dataDir);
	if (!lock) throw new Error('Another OpenPalm lifecycle operation is in progress.');
	try {
		const plan = applyLeanImport(options);
		ensureLeanRuntime(state);
		return plan;
	} finally {
		releaseLeanLock(lock);
	}
}
