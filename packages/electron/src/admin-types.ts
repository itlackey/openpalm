import type {
	AssistantReadiness,
	BackupManifest,
	ImportPlan,
	ProviderSummary,
	StackConfig
} from '@openpalm/lib';

export type AdminSnapshot = {
	installed: boolean;
	homeDir: string;
	configPath: string;
	config: StackConfig;
	services: Array<{
		name: string;
		state: string;
		health: string;
	}>;
	dockerError?: string;
	portalMappings: Record<string, { default: string; users: Record<string, string> }>;
	portalSecrets: Record<string, Record<string, boolean>>;
};

export type StackAction = 'start' | 'restart' | 'stop';

export type AdminApi = {
	snapshot(): Promise<AdminSnapshot>;
	install(config: StackConfig): Promise<AdminSnapshot>;
	saveConfig(config: StackConfig): Promise<AdminSnapshot>;
	action(action: StackAction): Promise<AdminSnapshot>;
	logs(): Promise<string>;
	providers(): Promise<ProviderSummary[]>;
	providerKey(value: { provider: string; key: string }): Promise<AssistantReadiness>;
	readiness(): Promise<AssistantReadiness>;
	credential(value: {
		action: 'create' | 'rotate' | 'remove';
		username: string;
		policy?: string;
	}): Promise<AdminSnapshot>;
	credentialKey(username: string): Promise<{ username: string; key: string }>;
	mapPortalUser(value: {
		portal: 'discord' | 'slack';
		userId: string;
		username?: string;
	}): Promise<AdminSnapshot>;
	portalToken(value: {
		portal: 'discord' | 'slack';
		botToken?: string;
		appToken?: string;
	}): Promise<AdminSnapshot>;
	backup(value: {
		destination: string;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}): Promise<BackupManifest>;
	importData(value: {
		sourceHome: string;
		apply?: boolean;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}): Promise<ImportPlan>;
};

export const ADMIN_CHANNELS = {
	snapshot: 'admin:snapshot',
	install: 'admin:install',
	saveConfig: 'admin:save-config',
	action: 'admin:action',
	logs: 'admin:logs',
	providers: 'admin:providers',
	providerKey: 'admin:provider-key',
	readiness: 'admin:readiness',
	credential: 'admin:credential',
	credentialKey: 'admin:credential-key',
	mapPortalUser: 'admin:map-portal-user',
	portalToken: 'admin:portal-token',
	backup: 'admin:backup',
	importData: 'admin:import'
} as const;
