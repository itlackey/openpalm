import { app, BrowserWindow } from 'electron';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { createAdminWindow, registerAdminIpc } from './admin-app.js';

if (process.platform === 'win32') app.setAppUserModelId('com.openpalm.admin');

const releaseSmoke = process.argv.includes('--openpalm-release-smoke');
if (releaseSmoke) {
	const home = process.env.OP_HOME;
	const expectedVersion = process.env.OPENPALM_ADMIN_SMOKE_VERSION;
	if (expectedVersion && app.getVersion() !== expectedVersion) {
		process.stderr.write(`Release smoke expected ${expectedVersion}, found ${app.getVersion()}.\n`);
		app.exit(1);
	} else if (!home || !isAbsolute(home) || (existsSync(home) && readdirSync(home).length !== 0)) {
		process.stderr.write('Release smoke requires an absolute, empty OP_HOME.\n');
		app.exit(1);
	} else {
		// Packaged startup uses the real preload and CSP, with no production-profile writes.
		app.setPath('userData', mkdtempSync(join(tmpdir(), 'openpalm-admin-release-profile-')));
	}
}

async function verifyPackagedStartup(window: BrowserWindow): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			(async () => {
				if (window.webContents.isLoading()) {
					await new Promise<void>((resolve, reject) => {
						window.webContents.once('did-finish-load', () => resolve());
						window.webContents.once('did-fail-load', (_event, code, description) => {
							reject(new Error(`Admin renderer failed to load (${code}): ${description}`));
						});
					});
				}
				await window.webContents.executeJavaScript(`(async () => {
					if (typeof window.openpalmAdmin?.snapshot !== 'function') {
						throw new Error('Packaged Admin preload bridge is missing.');
					}
					const snapshot = await window.openpalmAdmin.snapshot();
					if (snapshot.phase !== 'not_installed') throw new Error('Smoke home is not fresh.');
					await new Promise((resolve, reject) => {
						const started = Date.now();
						const check = () => {
							if (document.body.dataset.phase === 'not_installed' &&
								!document.querySelector('#install-section')?.hidden &&
								document.querySelector('#app-shell')?.hidden &&
								document.querySelector('#install-form')) return resolve();
							if (Date.now() - started > 10000) return reject(new Error('Packaged Admin did not render fresh setup.'));
							setTimeout(check, 50);
						};
						check();
					});
				})()`);
			})(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error('Packaged Admin startup timed out.')), 20_000);
			})
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

void app
	.whenReady()
	.then(async () => {
		registerAdminIpc();
		const window = createAdminWindow();
		if (releaseSmoke) {
			await verifyPackagedStartup(window);
			process.stdout.write('OPENPALM_ADMIN_SMOKE_OK\n');
			app.exit(0);
		}
	})
	.catch((error: unknown) => {
		process.stderr.write(
			`OpenPalm Admin could not start: ${error instanceof Error ? error.message : String(error)}\n`
		);
		app.exit(1);
	});
app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createAdminWindow();
});
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
