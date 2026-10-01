import {
	applyHomeSeed,
	applyImport,
	acquireStackLock,
	classifyInstall,
	createCredentialId,
	createBackup,
	createOpenPalmState,
	defaultStackConfig,
	ensureCredentialKeys,
	ensureHomeDirs,
	ensureRuntime,
	ensureOAuthFiles,
	generateCredentialKey,
	isCredentialUsername,
	isGuardianPolicy,
	isPortalName,
	isPortalUserId,
	oauthCredentialUsages,
	planImport,
	portalCredentialUsages,
	parseStackConfig,
	readPortalCredentialMap,
	readStackConfig,
	removeCredentialKey,
	releaseStackLock,
	syncPortalCredentialBundles,
	writeCredentialKey,
	writePortalCredentialMap,
	writeStackConfig,
	type GuardianPolicy,
	type PortalName,
	type StackConfig
} from '@openpalm/lib';

export function isAdminPageUrl(
	value: unknown,
	indexUrl: string,
	windows = process.platform === 'win32'
): boolean {
	if (typeof value !== 'string' || value.length > 4_096) return false;
	try {
		const url = new URL(value);
		if (url.protocol !== 'file:' || url.search || url.hash || url.username || url.password)
			return false;
		if (/%2f|%5c/i.test(url.pathname)) return false;
		const expected = new URL(indexUrl);
		if (url.hostname !== expected.hostname) return false;
		const path = decodeURIComponent(url.pathname);
		const expectedPath = decodeURIComponent(expected.pathname);
		return windows ? path.toLowerCase() === expectedPath.toLowerCase() : path === expectedPath;
	} catch {
		return false;
	}
}

export function externalAdminUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length > 4_096) throw new Error('Invalid external URL.');
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('Only HTTP or HTTPS links without embedded credentials can be opened.');
	}
	return url.href;
}

export function adminPortalTokens(
	value: unknown,
	configured: Record<string, boolean>
): { portal: PortalName; botToken?: string; appToken?: string } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid portal token operation');
	}
	const input = value as { portal?: unknown; botToken?: unknown; appToken?: unknown };
	if (!isPortalName(input.portal)) throw new Error('Portal must be discord or slack.');
	for (const token of [input.botToken, input.appToken]) {
		if (token !== undefined && typeof token !== 'string') throw new Error('Invalid portal token.');
	}
	const botToken = input.botToken as string | undefined;
	const appToken = input.appToken as string | undefined;
	if (input.portal === 'discord' && !botToken) throw new Error('Discord bot token is required.');
	if (
		input.portal === 'slack' &&
		((!configured.slack_bot_token && !botToken) || (!configured.slack_app_token && !appToken))
	) {
		throw new Error('Both Slack tokens are required the first time.');
	}
	if (input.portal === 'slack' && !botToken && !appToken) {
		throw new Error('Enter at least one Slack token to replace.');
	}
	return {
		portal: input.portal,
		...(botToken ? { botToken } : {}),
		...(input.portal === 'slack' && appToken ? { appToken } : {})
	};
}

export async function installFromAdmin(config: unknown = defaultStackConfig()): Promise<string> {
	const state = createOpenPalmState();
	if (classifyInstall(state.homeDir) !== 'not_installed') {
		throw new Error('OpenPalm is already installed or the selected home is not empty.');
	}
	const parsed = parseStackConfig(config);
	if (!parsed.ok) throw new Error(parsed.error);
	ensureHomeDirs(state.homeDir);
	await applyHomeSeed(state.homeDir);
	writeStackConfig(state.homeDir, parsed.config);
	ensureRuntime(state);
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
	return createBackup({ sourceHome: homeDir, ...value });
}

export function importFromAdmin(
	homeDir: string,
	value: {
		sourceHome: string;
		apply?: boolean;
		previewDigest?: string;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}
) {
	if (classifyInstall(homeDir) !== 'setup_incomplete') {
		throw new Error('Import is available only before setup is completed on a fresh installation.');
	}
	const { apply, previewDigest, ...importOptions } = value;
	const options = { destinationHome: homeDir, ...importOptions };
	if (!apply) return planImport(options);
	if (!previewDigest || !/^[a-f0-9]{64}$/.test(previewDigest)) {
		throw new Error('Preview this restore before applying it.');
	}
	const state = createOpenPalmState();
	if (state.homeDir !== homeDir) throw new Error('Admin import destination changed unexpectedly.');
	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw new Error('Another OpenPalm lifecycle operation is in progress.');
	try {
		const plan = applyImport(options, previewDigest);
		ensureRuntime(state);
		return plan;
	} finally {
		releaseStackLock(lock);
	}
}
