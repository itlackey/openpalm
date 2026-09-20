import { contextBridge, ipcRenderer } from 'electron';

import { ADMIN_CHANNELS, type AdminApi, type StackAction } from './admin-types.js';
import type { StackConfig } from '@openpalm/lib';

const api: AdminApi = {
	snapshot: () => ipcRenderer.invoke(ADMIN_CHANNELS.snapshot),
	install: (config: StackConfig) => ipcRenderer.invoke(ADMIN_CHANNELS.install, config),
	saveConfig: (config: StackConfig) => ipcRenderer.invoke(ADMIN_CHANNELS.saveConfig, config),
	action: (action: StackAction) => ipcRenderer.invoke(ADMIN_CHANNELS.action, action),
	logs: () => ipcRenderer.invoke(ADMIN_CHANNELS.logs),
	providers: () => ipcRenderer.invoke(ADMIN_CHANNELS.providers),
	providerKey: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.providerKey, value),
	readiness: () => ipcRenderer.invoke(ADMIN_CHANNELS.readiness),
	credential: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.credential, value),
	credentialKey: (username) => ipcRenderer.invoke(ADMIN_CHANNELS.credentialKey, username),
	mapPortalUser: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.mapPortalUser, value),
	portalToken: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.portalToken, value),
	backup: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.backup, value),
	importData: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.importData, value)
};

contextBridge.exposeInMainWorld('openpalmAdmin', api);
