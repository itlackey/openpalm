import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	activateLeanComposeCommand,
	buildLeanComposeOptions,
	classifyLeanInstall,
	composeLogs,
	composePs,
	createLeanState,
	defaultStackConfig,
	deactivateLeanComposeCommand,
	ensureDockerReady,
	ensureLeanRuntime,
	isCredentialUsername,
	isPortalName,
	listProviders,
	markLeanInstalled,
	parseComposePsRows,
	parseStackConfig,
	portalSecretConfigured,
	readCredentialKey,
	readStackConfig,
	requireLeanInstall,
	setProviderApiKey,
	stackConfigFile,
	testAssistantReadiness,
	writePortalSecret
} from '@openpalm/lib/lean';

import { ADMIN_CHANNELS, type AdminSnapshot, type StackAction } from './admin-types.js';
import {
	adminPortalMappings,
	backupFromAdmin,
	createAdminCredential,
	importFromAdmin,
	installFromAdmin,
	mapAdminPortalUser,
	removeAdminCredential,
	rotateAdminCredential,
	saveAdminConfig
} from './admin-domain.js';

const adminDirectory = fileURLToPath(new URL('../admin', import.meta.url));
const adminIndexPath = join(adminDirectory, 'index.html');
const adminIndexUrl = pathToFileURL(adminIndexPath).href;

if (!process.env.OPENPALM_SKELETON_DIR && !process.env.OPENPALM_REPO_ROOT) {
	process.env.OPENPALM_SKELETON_DIR = app.isPackaged
		? join(process.resourcesPath, 'skeleton')
		: join(import.meta.dirname, '..', '..', 'skeleton');
}

function requireAdminSender(event: IpcMainInvokeEvent): void {
	if (event.senderFrame?.url !== adminIndexUrl) throw new Error('Unauthorized admin IPC sender');
}

function state() {
	const value = createLeanState();
	requireLeanInstall(value.homeDir);
	ensureLeanRuntime(value);
	return value;
}

async function snapshot(): Promise<AdminSnapshot> {
	const candidate = createLeanState();
	const installState = classifyLeanInstall(candidate.homeDir);
	if (installState === 'not_installed') {
		return {
			installed: false,
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
	const result = await composePs(buildLeanComposeOptions(current));
	const services = result.ok
		? parseComposePsRows(result.stdout).map((row) => ({
				name: row.service,
				state: row.state,
				health: row.health
			}))
		: [];
	return {
		installed: true,
		homeDir: current.homeDir,
		configPath: stackConfigFile(current.homeDir),
		config: config.config,
		services,
		...(result.ok ? {} : { dockerError: result.stderr || 'Docker is unavailable' }),
		portalMappings: adminPortalMappings(current.homeDir),
		portalSecrets: {
			discord: portalSecretConfigured(current.homeDir, 'discord'),
			slack: portalSecretConfigured(current.homeDir, 'slack')
		}
	};
}

async function runAction(action: StackAction): Promise<AdminSnapshot> {
	const current = state();
	if (action === 'stop') {
		await deactivateLeanComposeCommand(current);
	} else if (action === 'restart') {
		await activateLeanComposeCommand(current, [
			'up',
			'-d',
			'--force-recreate',
			'--remove-orphans',
			'--wait'
		]);
	} else {
		await activateLeanComposeCommand(current, ['up', '-d', '--remove-orphans', '--wait']);
	}
	return snapshot();
}

function registerIpc(): void {
	ipcMain.handle(ADMIN_CHANNELS.snapshot, (event) => {
		requireAdminSender(event);
		return snapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.install, async (event) => {
		requireAdminSender(event);
		const docker = await ensureDockerReady();
		if (!docker.ok) throw new Error(docker.message);
		await installFromAdmin();
		return runAction('start');
	});
	ipcMain.handle(ADMIN_CHANNELS.saveConfig, async (event, value: unknown) => {
		requireAdminSender(event);
		const parsed = parseStackConfig(value);
		if (!parsed.ok) throw new Error(parsed.error);
		const current = state();
		saveAdminConfig(current.homeDir, parsed.config);
		return snapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.action, (event, action: unknown) => {
		requireAdminSender(event);
		if (action !== 'start' && action !== 'restart' && action !== 'stop') {
			throw new Error('Invalid stack action');
		}
		return runAction(action);
	});
	ipcMain.handle(ADMIN_CHANNELS.logs, async (event) => {
		requireAdminSender(event);
		const current = state();
		const result = await composeLogs(buildLeanComposeOptions(current), 250);
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
		const readiness = await testAssistantReadiness(current.homeDir);
		if (readiness.ok) markLeanInstalled(current.homeDir);
		return readiness;
	});
	ipcMain.handle(ADMIN_CHANNELS.readiness, (event) => {
		requireAdminSender(event);
		const current = state();
		return testAssistantReadiness(current.homeDir).then((readiness) => {
			if (readiness.ok) markLeanInstalled(current.homeDir);
			return readiness;
		});
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
		return snapshot();
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
		return snapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.portalToken, async (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object') throw new Error('Invalid portal token operation');
		const input = value as { portal?: unknown; botToken?: unknown; appToken?: unknown };
		if (!isPortalName(input.portal)) throw new Error('Portal must be discord or slack.');
		if (
			!(typeof input.botToken === 'string' && input.botToken) &&
			!(typeof input.appToken === 'string' && input.appToken)
		) {
			throw new Error('Enter at least one portal token.');
		}
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		if (typeof input.botToken === 'string' && input.botToken) {
			writePortalSecret(
				current.homeDir,
				input.portal,
				input.portal === 'discord' ? 'discord_bot_token' : 'slack_bot_token',
				input.botToken
			);
		}
		if (input.portal === 'slack' && typeof input.appToken === 'string' && input.appToken) {
			writePortalSecret(current.homeDir, 'slack', 'slack_app_token', input.appToken);
		}
		return config.config.portals[input.portal].enabled ? runAction('restart') : snapshot();
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

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 960,
		height: 720,
		minWidth: 720,
		minHeight: 560,
		title: 'OpenPalm Admin',
		webPreferences: {
			preload: join(import.meta.dirname, 'admin-preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith('https://')) void shell.openExternal(url);
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', (event, url) => {
		if (url !== adminIndexUrl) event.preventDefault();
	});
	void window.loadFile(adminIndexPath);
	return window;
}

if (process.platform === 'win32') app.setAppUserModelId('com.openpalm.admin');

await app.whenReady();
registerIpc();
createWindow();
app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
