import { contextBridge, ipcRenderer } from 'electron';

import { ADMIN_CHANNELS, type AdminApi, type StackAction } from './admin-types.js';
import type { StackConfig } from '@openpalm/lib/lean';

const api: AdminApi = {
	snapshot: () => ipcRenderer.invoke(ADMIN_CHANNELS.snapshot),
	saveConfig: (config: StackConfig) => ipcRenderer.invoke(ADMIN_CHANNELS.saveConfig, config),
	action: (action: StackAction) => ipcRenderer.invoke(ADMIN_CHANNELS.action, action),
	logs: () => ipcRenderer.invoke(ADMIN_CHANNELS.logs)
};

contextBridge.exposeInMainWorld('openpalmAdmin', api);
