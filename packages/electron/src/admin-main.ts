import { app, BrowserWindow } from 'electron';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { createAdminWindow, registerAdminIpc } from './admin-app.js';

if (process.platform === 'win32') app.setAppUserModelId('com.openpalm.admin');

const releaseSmoke = process.argv.includes('--openpalm-release-smoke');
function finishReleaseSmoke(error?: string): void {
	const report = process.env.OPENPALM_ADMIN_SMOKE_REPORT;
	if (report) {
		if (!isAbsolute(report)) throw new Error('Release smoke report must be an absolute path.');
		writeFileSync(report, JSON.stringify({ ok: !error, version: app.getVersion(), error }), {
			flag: 'wx',
			mode: 0o600
		});
	} else if (error) {
		process.stderr.write(`${error}\n`);
	} else {
		process.stdout.write('OPENPALM_ADMIN_SMOKE_OK\n');
	}
	app.exit(error ? 1 : 0);
}
if (releaseSmoke) {
	const home = process.env.OP_HOME;
	const expectedVersion = process.env.OPENPALM_ADMIN_SMOKE_VERSION;
	if (expectedVersion && app.getVersion() !== expectedVersion) {
		finishReleaseSmoke(`Release smoke expected ${expectedVersion}, found ${app.getVersion()}.`);
	} else if (!home || !isAbsolute(home) || (existsSync(home) && readdirSync(home).length !== 0)) {
		finishReleaseSmoke('Release smoke requires an absolute, empty OP_HOME.');
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
					const welcome = await window.openpalmAdmin.welcome();
					if (welcome.selectedInstance || welcome.recentInstances.length) throw new Error('Smoke profile is not fresh.');
					await new Promise((resolve, reject) => {
						const started = Date.now();
						const check = () => {
							if (document.body.dataset.phase === 'welcome' &&
								!document.querySelector('#instance-welcome')?.hidden &&
									document.querySelector('#app-shell')?.hidden &&
									document.querySelector('#open-recent-instance')) return resolve();
							if (Date.now() - started > 10000) return reject(new Error('Packaged Admin did not render its welcome screen.'));
							setTimeout(check, 50);
						};
						check();
					});
					await window.openpalmAdmin.openInstance(welcome.defaultInstance);
					const snapshot = await window.openpalmAdmin.snapshot();
					if (snapshot.phase !== 'not_installed') throw new Error('Smoke home is not fresh.');
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
			finishReleaseSmoke();
		}
	})
	.catch((error: unknown) => {
		if (releaseSmoke) {
			finishReleaseSmoke(error instanceof Error ? error.message : String(error));
			return;
		}
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
