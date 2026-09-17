import type { StackConfig } from '@openpalm/lib/lean';

export type AdminSnapshot = {
	homeDir: string;
	configPath: string;
	config: StackConfig;
	services: Array<{
		name: string;
		state: string;
		health: string;
	}>;
	dockerError?: string;
};

export type StackAction = 'start' | 'restart' | 'stop';

export type AdminApi = {
	snapshot(): Promise<AdminSnapshot>;
	saveConfig(config: StackConfig): Promise<AdminSnapshot>;
	action(action: StackAction): Promise<AdminSnapshot>;
	logs(): Promise<string>;
};

export const ADMIN_CHANNELS = {
	snapshot: 'admin:snapshot',
	saveConfig: 'admin:save-config',
	action: 'admin:action',
	logs: 'admin:logs'
} as const;
