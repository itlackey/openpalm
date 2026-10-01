import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	activateComposeCommand,
	beginRemoteEnable,
	disableRemote,
	remoteTool,
	remoteBrowserUrls,
	remoteConnection,
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
import { reviewCodexRecall, changeCodexRecall } from '@openpalm/lib';
import type { AssistantReadiness, RemoteEnableSession, CodexRecallReview } from '@openpalm/lib';

import electronPackage from '../package.json' with { type: 'json' };
import { AdminInstances } from './admin-instances.js';

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
const adminIndexUrl = pathToFileURL(adminIndexPath).href;
const claudeExtensionUrl = `https://github.com/itlackey/openpalm/releases/download/${electronPackage.version}/openpalm-claude-desktop-${electronPackage.version}.mcpb`;
let activeRemote: { homeDir: string; session: RemoteEnableSession } | undefined;
let remoteStarting = false;
let instances: AdminInstances;
let pendingOAuth: { homeDir: string; provider: string; method: number } | undefined;

function managedState() {
	return createOpenPalmState(instances.current().homeDir);
}

function handleAdmin(
	channel: string,
	handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown
): void {
	ipcMain.handle(channel, (event, value: unknown) => {
		requireAdminSender(event);
		return instances.run(() => handler(event, value));
	});
}

function requireSwitchable(): void {
	instances.assertIdle();
	if (remoteStarting || activeRemote?.session.snapshot().running)
		throw new Error('Finish or cancel native remote setup before switching instances.');
}

if (!process.env.OPENPALM_SKELETON_DIR && !process.env.OPENPALM_REPO_ROOT) {
	process.env.OPENPALM_SKELETON_DIR = app.isPackaged
		? join(process.resourcesPath, 'skeleton')
		: join(import.meta.dirname, '..', '..', 'skeleton');
}

function requireAdminSender(event: IpcMainInvokeEvent): void {
	if (
		event.senderFrame !== event.sender.mainFrame ||
		!isAdminPageUrl(event.senderFrame?.url, adminIndexUrl)
	)
		throw new Error('Unauthorized admin IPC sender');
}

function state() {
	const value = managedState();
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
	const candidate = managedState();
	const installState = classifyInstall(candidate.homeDir);
	if (installState === 'not_installed') {
		return {
			installationReadiness: await ensureDockerReady(),
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
	let recall: CodexRecallReview | undefined;
	let recallError: string | undefined;
	if (services.some((s) => s.name === 'assistant' && s.state === 'running')) {
		try {
			recall = await reviewCodexRecall(current);
		} catch (error) {
			recallError = error instanceof Error ? error.message : String(error);
		}
	}
	return {
		phase: installState === 'installed' ? 'ready' : 'setup_incomplete',
		homeDir: current.homeDir,
		configPath: stackConfigFile(current.homeDir),
		config: config.config,
		services,
		...(recall ? { codexRecall: recall } : {}),
		...(recallError ? { codexRecallError: recallError } : {}),
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
	instances = new AdminInstances(app.getPath('userData'));
	ipcMain.handle(ADMIN_CHANNELS.welcome, (event) => {
		requireAdminSender(event);
		return instances.welcome();
	});
	ipcMain.handle(ADMIN_CHANNELS.openInstance, (event, target: unknown) => {
		requireAdminSender(event);
		requireSwitchable();
		instances.open(target);
		activeRemote = undefined;
		pendingOAuth = undefined;
	});
	ipcMain.handle(ADMIN_CHANNELS.closeInstance, (event) => {
		requireAdminSender(event);
		requireSwitchable();
		instances.close();
		activeRemote = undefined;
		pendingOAuth = undefined;
	});
	handleAdmin(ADMIN_CHANNELS.codexRecall, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid recall request.');
		const input = value as Record<string, unknown>;
		const current = state();
		if (input.action === 'review') return reviewCodexRecall(current);
		if (input.action !== 'approve' && input.action !== 'disable')
			throw new Error('Unknown recall action.');
		if (typeof input.digest !== 'string') throw new Error('Review the current hooks first.');
		if (remoteStarting || activeRemote?.session.snapshot().running)
			throw new Error('Finish or cancel remote setup first.');
		return changeCodexRecall(current, input.action, input.digest, input.confirmed === true);
	});
	handleAdmin(ADMIN_CHANNELS.remote, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid native remote request.');
		const input = value as Record<string, unknown>;
		const tool = remoteTool(input.tool);
		const current = state();
		if (input.action === 'connection') {
			const output = await remoteConnection(current, tool);
			for (const url of remoteBrowserUrls(output))
				void shell.openExternal(url).catch(() => undefined);
			return { tool, stage: 'connection', output, running: false, enabled: true };
		}
		if (input.action === 'enable') {
			if (remoteStarting || activeRemote?.session.snapshot().running)
				throw new Error('Finish or cancel the current remote setup first.');
			if (
				input.sandbox !== undefined &&
				input.sandbox !== 'workspace-write' &&
				input.sandbox !== 'read-only'
			)
				throw new Error('Invalid Codex sandbox mode.');
			remoteStarting = true;
			const opened = new Set<string>();
			try {
				const session = await beginRemoteEnable(current, tool, {
					trusted: input.trusted === true,
					sandbox: input.sandbox as 'workspace-write' | 'read-only' | undefined,
					update(progress) {
						for (const url of remoteBrowserUrls(progress.output)) {
							if (opened.has(url)) continue;
							opened.add(url);
							void shell.openExternal(url).catch(() => undefined);
						}
					}
				});
				activeRemote = { homeDir: current.homeDir, session };
				return session.snapshot();
			} finally {
				remoteStarting = false;
			}
		}
		if (input.action === 'disable') {
			await disableRemote(current, tool);
			return { tool, stage: 'disabled', output: '', running: false, enabled: false };
		}
		if (
			!activeRemote ||
			activeRemote.homeDir !== current.homeDir ||
			activeRemote.session.snapshot().tool !== tool
		)
			throw new Error('Start remote setup for this installation first.');
		if (input.action === 'input') {
			if (typeof input.input !== 'string') throw new Error('A native prompt answer is required.');
			activeRemote.session.input(input.input);
		} else if (input.action === 'cancel') {
			activeRemote.session.cancel();
			return activeRemote.session.done;
		} else if (input.action !== 'progress') throw new Error('Unknown remote setup action.');
		return activeRemote.session.snapshot();
	});
	app.on('before-quit', (event) => {
		if (!activeRemote?.session.snapshot().running) return;
		event.preventDefault();
		activeRemote.session.cancel();
		void activeRemote.session.done.finally(() => app.quit());
	});
	handleAdmin(ADMIN_CHANNELS.snapshot, (_event) => {
		return adminSnapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.selectedHome, (event) => {
		requireAdminSender(event);
		const welcome = instances.welcome();
		return welcome.selectedInstance?.homeDir ?? welcome.defaultInstance.homeDir;
	});
	handleAdmin(ADMIN_CHANNELS.install, async (_event, value: unknown) => {
		const parsed = parseStackConfig(value);
		if (!parsed.ok) throw new Error(parsed.error);
		const docker = await ensureDockerReady();
		if (!docker.ok) throw new Error(docker.message);
		await installFromAdmin(parsed.config, instances.current().homeDir);
		return runAdminAction('start');
	});
	handleAdmin(ADMIN_CHANNELS.saveConfig, async (_event, value: unknown) => {
		const parsed = parseStackConfig(value);
		if (!parsed.ok) throw new Error(parsed.error);
		const current = state();
		saveAdminConfig(current.homeDir, parsed.config);
		return adminSnapshot();
	});
	handleAdmin(ADMIN_CHANNELS.action, (_event, action: unknown) => {
		if (action !== 'start' && action !== 'restart' && action !== 'stop') {
			throw new Error('Invalid stack action');
		}
		return runAdminAction(action);
	});
	handleAdmin(ADMIN_CHANNELS.logs, async (_event) => {
		const current = state();
		const result = await composeLogs(buildComposeOptions(current), 250);
		if (!result.ok) throw new Error(result.stderr || 'Could not read Docker logs');
		return result.stdout.slice(-200_000);
	});
	handleAdmin(ADMIN_CHANNELS.providers, (_event) => {
		const current = state();
		return listProviders(current.homeDir);
	});
	handleAdmin(ADMIN_CHANNELS.providerKey, async (_event, value: unknown) => {
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
	handleAdmin(ADMIN_CHANNELS.providerOAuthStart, async (_event, value: unknown) => {
		const input = oauthInput(value);
		const current = state();
		const authorization = await beginProviderOAuth(
			current.homeDir,
			input.provider,
			input.method,
			input.inputs
		);
		pendingOAuth = { homeDir: current.homeDir, provider: input.provider, method: input.method };
		await shell.openExternal(externalAdminUrl(authorization.url));
		return authorization;
	});
	handleAdmin(ADMIN_CHANNELS.providerOAuthFinish, async (_event, value: unknown) => {
		const input = oauthInput(value);
		const rawCode = (value as { code?: unknown }).code;
		if (rawCode !== undefined && typeof rawCode !== 'string') {
			throw new Error('Invalid provider authorization code.');
		}
		const current = state();
		if (
			!pendingOAuth ||
			pendingOAuth.homeDir !== current.homeDir ||
			pendingOAuth.provider !== input.provider ||
			pendingOAuth.method !== input.method
		)
			throw new Error('Start provider sign-in for this instance first.');
		await completeProviderOAuth(current.homeDir, input.provider, input.method, rawCode);
		pendingOAuth = undefined;
		const readiness = await testAssistantReadiness(current.homeDir, {
			provider: input.provider
		});
		await completeAdminReadiness(current.homeDir, readiness);
		return readiness;
	});
	handleAdmin(ADMIN_CHANNELS.readiness, (_event, value: unknown) => {
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
	handleAdmin(ADMIN_CHANNELS.assistantPassword, (_event) => {
		const current = state();
		const details = connectionDetails(current.homeDir, 'opencode', {
			showAssistantPassword: true
		});
		if (!details.password) throw new Error('OpenCode password is unavailable.');
		return { password: details.password };
	});
	handleAdmin(ADMIN_CHANNELS.copyText, (_event, value: unknown) => {
		if (typeof value !== 'string' || value.length < 1 || value.length > 10_000) {
			throw new Error('Invalid clipboard value.');
		}
		clipboard.writeText(value);
	});
	handleAdmin(ADMIN_CHANNELS.openExternal, async (_event, value: unknown) => {
		await shell.openExternal(externalAdminUrl(value));
	});
	ipcMain.handle(ADMIN_CHANNELS.chooseDirectory, async (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Invalid directory selection request.');
		}
		const purpose = (value as { purpose?: unknown }).purpose;
		if (purpose !== 'backup' && purpose !== 'restore' && purpose !== 'instance') {
			throw new Error('Directory purpose must be instance, backup or restore.');
		}
		const options: OpenDialogOptions = {
			title:
				purpose === 'instance'
					? 'Open an OpenPalm folder'
					: purpose === 'backup'
						? 'Choose an empty backup directory'
						: 'Choose an OpenPalm backup',
			buttonLabel:
				purpose === 'instance'
					? 'Open instance'
					: purpose === 'backup'
						? 'Use for backup'
						: 'Use this backup',
			properties: purpose === 'restore' ? ['openDirectory'] : ['openDirectory', 'createDirectory']
		};
		const owner = BrowserWindow.fromWebContents(event.sender);
		const result = owner
			? await dialog.showOpenDialog(owner, options)
			: await dialog.showOpenDialog(options);
		return result.canceled ? undefined : result.filePaths[0];
	});
	handleAdmin(ADMIN_CHANNELS.credential, async (_event, value: unknown) => {
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
	handleAdmin(ADMIN_CHANNELS.credentialKey, (_event, value: unknown) => {
		if (!isCredentialUsername(value)) throw new Error('Invalid credential username.');
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		if (!Object.hasOwn(config.config.credentials, value)) {
			throw new Error(`Unknown credential: ${value}`);
		}
		return { username: value, key: readCredentialKey(current.homeDir, value) };
	});
	handleAdmin(ADMIN_CHANNELS.mapPortalUser, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid portal mapping');
		const current = state();
		mapAdminPortalUser(current.homeDir, value as never);
		return adminSnapshot();
	});
	handleAdmin(ADMIN_CHANNELS.portalToken, async (_event, value: unknown) => {
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
	handleAdmin(ADMIN_CHANNELS.backup, (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid backup request');
		const current = state();
		return backupFromAdmin(current.homeDir, value as never);
	});
	handleAdmin(ADMIN_CHANNELS.importData, (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid import request');
		const current = state();
		return importFromAdmin(current.homeDir, value as never);
	});
}

export function createAdminWindow(options: { show?: boolean } = {}): BrowserWindow {
	// Initial size only. Setup, navigation and instance reloads never resize it.
	const window = new BrowserWindow({
		width: 1120,
		height: 780,
		minWidth: 640,
		minHeight: 540,
		title: 'OpenPalm — Setup & settings',
		backgroundColor: '#0d1117',
		show: options.show ?? true,
		webPreferences: {
			preload: join(import.meta.dirname, 'admin-preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	window.on('closed', () => activeRemote?.session.cancel());
	window.webContents.setWindowOpenHandler(({ url }) => {
		try {
			void shell.openExternal(externalAdminUrl(url)).catch(() => undefined);
		} catch {
			// Keep untrusted or malformed renderer navigation inside the deny-only boundary.
		}
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', (event, url) => {
		if (!isAdminPageUrl(url, adminIndexUrl)) event.preventDefault();
	});
	void window.loadFile(adminIndexPath);
	return window;
}
