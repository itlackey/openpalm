import { app, BrowserWindow } from 'electron';

import { createAdminWindow, registerAdminIpc } from './admin-app.js';

if (process.platform === 'win32') app.setAppUserModelId('com.openpalm.admin');

void app.whenReady().then(() => {
	registerAdminIpc();
	createAdminWindow();
});
app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createAdminWindow();
});
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
