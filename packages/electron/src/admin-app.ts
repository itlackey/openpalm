import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	activateComposeCommand,
	beginProviderOAuth,
	buildComposeOptions,
	classifyInstall,
	composeLogs,
	composePs,
	completeProviderOAuth,
	configureGuardianModeratorModel,
	connectionDetails,
	createOpenPalmState,
	defaultStackConfig,
	deactivateComposeCommand,
	ensureDockerReady,
	ensureRuntime,
	isCredentialUsername,
	isPortalName,
	listProviders,
	markInstalled,
	parseComposePsRows,
	parseStackConfig,
	portalSecretConfigured,
	readCredentialKey,
	readStackConfig,
	requireInstall,
	setProviderApiKey,
	stackConfigFile,
	testAssistantReadiness,
	writePortalSecret
} from '@openpalm/lib';
import type { AssistantReadiness } from '@openpalm/lib';

import electronPackage from '../package.json' with { type: 'json' };

import { ADMIN_CHANNELS, type AdminSnapshot, type StackAction } from './admin-types.js';
import {
	adminPortalMappings,
	adminPortalTokens,
	backupFromAdmin,
	createAdminCredential,
	externalAdminUrl,
	importFromAdmin,
	installFromAdmin,
	isAdminPageUrl,
	mapAdminPortalUser,
	removeAdminCredential,
	rotateAdminCredential,
	saveAdminConfig
} from './admin-domain.js';

const adminDirectory = fileURLToPath(new URL('../admin', import.meta.url));
const adminIndexPath = join(adminDirectory, 'index.html');
const claudeExtensionUrl = `https://github.com/itlackey/openpalm/releases/download/${electronPackage.version}/openpalm-claude-desktop-${electronPackage.version}.mcpb`;

if (!process.env.OPENPALM_SKELETON_DIR && !process.env.OPENPALM_REPO_ROOT) {
	process.env.OPENPALM_SKELETON_DIR = app.isPackaged
		? join(process.resourcesPath, 'skeleton')
		: join(import.meta.dirname, '..', '..', 'skeleton');
}

function requireAdminSender(event: IpcMainInvokeEvent): void {
	if (
		event.senderFrame !== event.sender.mainFrame ||
		!isAdminPageUrl(event.senderFrame?.url, adminIndexPath)
	)
		throw new Error('Unauthorized admin IPC sender');
}

function state() {
	const value = createOpenPalmState();
	requireInstall(value.homeDir);
	ensureRuntime(value);
	return value;
}

function connectionSnapshot(homeDir: string): NonNullable<AdminSnapshot['connectionDetails']> {
	return {
		opencode: connectionDetails(homeDir, 'opencode'),
		mcp: connectionDetails(homeDir, 'mcp'),
		claude: connectionDetails(homeDir, 'claude', { claudeExtension: claudeExtensionUrl })
	};
}

function oauthInput(value: unknown): {
	provider: string;
	method: number;
	inputs?: Record<string, string>;
} {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid provider sign-in request.');
	}
	const input = value as { provider?: unknown; method?: unknown; inputs?: unknown };
	if (typeof input.provider !== 'string' || typeof input.method !== 'number') {
		throw new Error('Provider and sign-in method are required.');
	}
	if (
		input.inputs !== undefined &&
		(!input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs))
	) {
		throw new Error('Invalid provider sign-in fields.');
	}
	if (
		input.inputs &&
		Object.values(input.inputs as Record<string, unknown>).some((item) => typeof item !== 'string')
	) {
		throw new Error('Invalid provider sign-in fields.');
	}
	return {
		provider: input.provider,
		method: input.method,
		...(input.inputs ? { inputs: input.inputs as Record<string, string> } : {})
	};
}

export async function adminSnapshot(): Promise<AdminSnapshot> {
	const candidate = createOpenPalmState();
	const installState = classifyInstall(candidate.homeDir);
	if (installState === 'not_installed') {
		return {
			phase: 'not_installed',
			homeDir: candidate.homeDir,
			configPath: stackConfigFile(candidate.homeDir),
			config: defaultStackConfig(),
			services: [],
			portalMappings: {},
			portalSecrets: {}
		};
	}
	if (installState === 'incompatible_home') {
		throw new Error('The selected OP_HOME is not empty and is not an OpenPalm 0.14 installation.');
	}
	const current = state();
	const config = readStackConfig(current.homeDir);
	if (!config.ok) throw new Error(config.error);
	const result = await composePs(buildComposeOptions(current));
	const services = result.ok
		? parseComposePsRows(result.stdout).map((row) => ({
				name: row.service,
				state: row.state,
				health: row.health
			}))
		: [];
	return {
		phase: installState === 'installed' ? 'ready' : 'setup_incomplete',
		homeDir: current.homeDir,
		configPath: stackConfigFile(current.homeDir),
		config: config.config,
		services,
		...(result.ok ? {} : { dockerError: result.stderr || 'Docker is unavailable' }),
		portalMappings: adminPortalMappings(current.homeDir),
		portalSecrets: {
			discord: portalSecretConfigured(current.homeDir, 'discord'),
			slack: portalSecretConfigured(current.homeDir, 'slack')
		},
		connectionDetails: connectionSnapshot(current.homeDir)
	};
}

export async function runAdminAction(action: StackAction): Promise<AdminSnapshot> {
	const current = state();
	if (action === 'stop') {
		await deactivateComposeCommand(current);
	} else if (action === 'restart') {
		await activateComposeCommand(current, [
			'up',
			'-d',
			'--force-recreate',
			'--remove-orphans',
			'--wait'
		]);
	} else {
		await activateComposeCommand(current, ['up', '-d', '--remove-orphans', '--wait']);
	}
	return adminSnapshot();
}

async function completeAdminReadiness(
	homeDir: string,
	readiness: AssistantReadiness
): Promise<void> {
	if (!readiness.ok) return;
	const moderatorUpdated = configureGuardianModeratorModel(
		homeDir,
		readiness.provider,
		readiness.model
	);
	markInstalled(homeDir);
	const config = readStackConfig(homeDir);
	if (!config.ok) throw new Error(config.error);
	if (moderatorUpdated && config.config.gateway.enabled) await runAdminAction('restart');
}

export function registerAdminIpc(): void {
	ipcMain.handle(ADMIN_CHANNELS.snapshot, (event) => {
		requireAdminSender(event);
		return adminSnapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.selectedHome, (event) => {
		requireAdminSender(event);
		return createOpenPalmState().homeDir;
	});
	ipcMain.handle(ADMIN_CHANNELS.install, async (event, value: unknown) => {
		requireAdminSender(event);
		const parsed = parseStackConfig(value);
		if (!parsed.ok) throw new Error(parsed.error);
		const docker = await ensureDockerReady();
		if (!docker.ok) throw new Error(docker.message);
		await installFromAdmin(parsed.config);
		return runAdminAction('start');
	});
	ipcMain.handle(ADMIN_CHANNELS.saveConfig, async (event, value: unknown) => {
		requireAdminSender(event);
		const parsed = parseStackConfig(value);
		if (!parsed.ok) throw new Error(parsed.error);
		const current = state();
		saveAdminConfig(current.homeDir, parsed.config);
		return adminSnapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.action, (event, action: unknown) => {
		requireAdminSender(event);
		if (action !== 'start' && action !== 'restart' && action !== 'stop') {
			throw new Error('Invalid stack action');
		}
		return runAdminAction(action);
	});
	ipcMain.handle(ADMIN_CHANNELS.logs, async (event) => {
		requireAdminSender(event);
		const current = state();
		const result = await composeLogs(buildComposeOptions(current), 250);
		if (!result.ok) throw new Error(result.stderr || 'Could not read Docker logs');
		return result.stdout.slice(-200_000);
	});
	ipcMain.handle(ADMIN_CHANNELS.providers, (event) => {
		requireAdminSender(event);
		const current = state();
		return listProviders(current.homeDir);
	});
	ipcMain.handle(ADMIN_CHANNELS.providerKey, async (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object') throw new Error('Invalid provider settings');
		const input = value as { provider?: unknown; key?: unknown };
		if (typeof input.provider !== 'string' || typeof input.key !== 'string') {
			throw new Error('Provider and key are required.');
		}
		const current = state();
		await setProviderApiKey(current.homeDir, input.provider, input.key);
		const readiness = await testAssistantReadiness(current.homeDir, {
			provider: input.provider
		});
		await completeAdminReadiness(current.homeDir, readiness);
		return readiness;
	});
	ipcMain.handle(ADMIN_CHANNELS.providerOAuthStart, async (event, value: unknown) => {
		requireAdminSender(event);
		const input = oauthInput(value);
		const current = state();
		const authorization = await beginProviderOAuth(
			current.homeDir,
			input.provider,
			input.method,
			input.inputs
		);
		await shell.openExternal(externalAdminUrl(authorization.url));
		return authorization;
	});
	ipcMain.handle(ADMIN_CHANNELS.providerOAuthFinish, async (event, value: unknown) => {
		requireAdminSender(event);
		const input = oauthInput(value);
		const rawCode = (value as { code?: unknown }).code;
		if (rawCode !== undefined && typeof rawCode !== 'string') {
			throw new Error('Invalid provider authorization code.');
		}
		const current = state();
		await completeProviderOAuth(current.homeDir, input.provider, input.method, rawCode);
		const readiness = await testAssistantReadiness(current.homeDir, {
			provider: input.provider
		});
		await completeAdminReadiness(current.homeDir, readiness);
		return readiness;
	});
	ipcMain.handle(ADMIN_CHANNELS.readiness, (event, value: unknown) => {
		requireAdminSender(event);
		if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
			throw new Error('Invalid provider readiness request.');
		}
		const rawProvider = (value as { provider?: unknown } | undefined)?.provider;
		if (rawProvider !== undefined && typeof rawProvider !== 'string') {
			throw new Error('Invalid readiness provider.');
		}
		const current = state();
		return testAssistantReadiness(current.homeDir, {
			...(rawProvider ? { provider: rawProvider } : {})
		}).then(async (readiness) => {
			await completeAdminReadiness(current.homeDir, readiness);
			return readiness;
		});
	});
	ipcMain.handle(ADMIN_CHANNELS.assistantPassword, (event) => {
		requireAdminSender(event);
		const current = state();
		const details = connectionDetails(current.homeDir, 'opencode', {
			showAssistantPassword: true
		});
		if (!details.password) throw new Error('OpenCode password is unavailable.');
		return { password: details.password };
	});
	ipcMain.handle(ADMIN_CHANNELS.copyText, (event, value: unknown) => {
		requireAdminSender(event);
		if (typeof value !== 'string' || value.length < 1 || value.length > 10_000) {
			throw new Error('Invalid clipboard value.');
		}
		clipboard.writeText(value);
	});
	ipcMain.handle(ADMIN_CHANNELS.openExternal, async (event, value: unknown) => {
		requireAdminSender(event);
		await shell.openExternal(externalAdminUrl(value));
	});
	ipcMain.handle(ADMIN_CHANNELS.chooseDirectory, async (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Invalid directory selection request.');
		}
		const purpose = (value as { purpose?: unknown }).purpose;
		if (purpose !== 'backup' && purpose !== 'restore') {
			throw new Error('Directory purpose must be backup or restore.');
		}
		const options: OpenDialogOptions = {
			title:
				purpose === 'backup' ? 'Choose an empty backup directory' : 'Choose an OpenPalm backup',
			buttonLabel: purpose === 'backup' ? 'Use for backup' : 'Use this backup',
			properties: purpose === 'backup' ? ['openDirectory', 'createDirectory'] : ['openDirectory']
		};
		const owner = BrowserWindow.fromWebContents(event.sender);
		const result = owner
			? await dialog.showOpenDialog(owner, options)
			: await dialog.showOpenDialog(options);
		return result.canceled ? undefined : result.filePaths[0];
	});
	ipcMain.handle(ADMIN_CHANNELS.credential, async (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object') throw new Error('Invalid credential operation');
		const input = value as { action?: unknown; username?: unknown; policy?: unknown };
		const current = state();
		if (input.action === 'create') {
			createAdminCredential(current.homeDir, {
				username: input.username,
				policy: input.policy
			});
		} else if (input.action === 'rotate') rotateAdminCredential(current.homeDir, input.username);
		else if (input.action === 'remove') removeAdminCredential(current.homeDir, input.username);
		else throw new Error('Invalid credential operation');
		return adminSnapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.credentialKey, (event, value: unknown) => {
		requireAdminSender(event);
		if (!isCredentialUsername(value)) throw new Error('Invalid credential username.');
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		if (!Object.hasOwn(config.config.credentials, value)) {
			throw new Error(`Unknown credential: ${value}`);
		}
		return { username: value, key: readCredentialKey(current.homeDir, value) };
	});
	ipcMain.handle(ADMIN_CHANNELS.mapPortalUser, async (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object') throw new Error('Invalid portal mapping');
		const current = state();
		mapAdminPortalUser(current.homeDir, value as never);
		return adminSnapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.portalToken, async (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object') throw new Error('Invalid portal token operation');
		const input = value as { portal?: unknown; botToken?: unknown; appToken?: unknown };
		if (!isPortalName(input.portal)) throw new Error('Portal must be discord or slack.');
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		const configured = portalSecretConfigured(current.homeDir, input.portal);
		const { botToken, appToken } = adminPortalTokens(value, configured);
		if (botToken) {
			writePortalSecret(
				current.homeDir,
				input.portal,
				input.portal === 'discord' ? 'discord_bot_token' : 'slack_bot_token',
				botToken
			);
		}
		if (input.portal === 'slack' && appToken) {
			writePortalSecret(current.homeDir, 'slack', 'slack_app_token', appToken);
		}
		return config.config.portals[input.portal].enabled
			? runAdminAction('restart')
			: adminSnapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.backup, (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object') throw new Error('Invalid backup request');
		const current = state();
		return backupFromAdmin(current.homeDir, value as never);
	});
	ipcMain.handle(ADMIN_CHANNELS.importData, (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object') throw new Error('Invalid import request');
		const current = state();
		return importFromAdmin(current.homeDir, value as never);
	});
}

export function createAdminWindow(options: { show?: boolean } = {}): BrowserWindow {
	const window = new BrowserWindow({
		width: 1120,
		height: 780,
		minWidth: 640,
		minHeight: 540,
		title: 'OpenPalm — Setup & settings',
		show: options.show ?? true,
		webPreferences: {
			preload: join(import.meta.dirname, 'admin-preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		try {
			void shell.openExternal(externalAdminUrl(url)).catch(() => undefined);
		} catch {
			// Keep untrusted or malformed renderer navigation inside the deny-only boundary.
		}
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', (event, url) => {
		if (!isAdminPageUrl(url, adminIndexPath)) event.preventDefault();
	});
	void window.loadFile(adminIndexPath);
	return window;
}
