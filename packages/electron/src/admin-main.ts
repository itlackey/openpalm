import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	activateLeanComposeCommand,
	buildLeanComposeOptions,
	composeLogs,
	composePs,
	createLeanState,
	deactivateLeanComposeCommand,
	ensureLeanRuntime,
	parseComposePsRows,
	parseStackConfig,
	readStackConfig,
	requireLeanInstall,
	stackConfigFile,
	writeStackConfig
} from '@openpalm/lib/lean';

import { ADMIN_CHANNELS, type AdminSnapshot, type StackAction } from './admin-types.js';

const adminDirectory = fileURLToPath(new URL('../admin', import.meta.url));
const adminIndexPath = join(adminDirectory, 'index.html');
const adminIndexUrl = pathToFileURL(adminIndexPath).href;

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
		homeDir: current.homeDir,
		configPath: stackConfigFile(current.homeDir),
		config: config.config,
		services,
		...(result.ok ? {} : { dockerError: result.stderr || 'Docker is unavailable' })
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
	ipcMain.handle(ADMIN_CHANNELS.saveConfig, async (event, value: unknown) => {
		requireAdminSender(event);
		const parsed = parseStackConfig(value);
		if (!parsed.ok) throw new Error(parsed.error);
		const current = state();
		writeStackConfig(current.homeDir, parsed.config);
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
