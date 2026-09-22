import type {
	AssistantReadiness,
	BackupManifest,
	ConnectionDetails,
	ImportPlan,
	ProviderOAuthAuthorization,
	ProviderSummary,
	StackConfig
} from '@openpalm/lib';

export type AdminSnapshot = {
	phase: 'not_installed' | 'setup_incomplete' | 'ready';
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
	connectionDetails?: {
		opencode: ConnectionDetails;
		mcp: ConnectionDetails;
		claude: ConnectionDetails;
	};
};

export type StackAction = 'start' | 'restart' | 'stop';

export type AdminApi = {
	snapshot(): Promise<AdminSnapshot>;
	selectedHome(): Promise<string>;
	install(config: StackConfig): Promise<AdminSnapshot>;
	saveConfig(config: StackConfig): Promise<AdminSnapshot>;
	action(action: StackAction): Promise<AdminSnapshot>;
	logs(): Promise<string>;
	providers(): Promise<ProviderSummary[]>;
	providerKey(value: { provider: string; key: string }): Promise<AssistantReadiness>;
	providerOAuthStart(value: {
		provider: string;
		method: number;
		inputs?: Record<string, string>;
	}): Promise<ProviderOAuthAuthorization>;
	providerOAuthFinish(value: {
		provider: string;
		method: number;
		code?: string;
	}): Promise<AssistantReadiness>;
	readiness(value?: { provider?: string }): Promise<AssistantReadiness>;
	assistantPassword(): Promise<{ password: string }>;
	copyText(value: string): Promise<void>;
	openExternal(value: string): Promise<void>;
	chooseDirectory(value: { purpose: 'backup' | 'restore' }): Promise<string | undefined>;
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
		previewDigest?: string;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}): Promise<ImportPlan>;
};

export const ADMIN_CHANNELS = {
	snapshot: 'admin:snapshot',
	selectedHome: 'admin:selected-home',
	install: 'admin:install',
	saveConfig: 'admin:save-config',
	action: 'admin:action',
	logs: 'admin:logs',
	providers: 'admin:providers',
	providerKey: 'admin:provider-key',
	providerOAuthStart: 'admin:provider-oauth-start',
	providerOAuthFinish: 'admin:provider-oauth-finish',
	readiness: 'admin:readiness',
	assistantPassword: 'admin:assistant-password',
	copyText: 'admin:copy-text',
	openExternal: 'admin:open-external',
	chooseDirectory: 'admin:choose-directory',
	credential: 'admin:credential',
	credentialKey: 'admin:credential-key',
	mapPortalUser: 'admin:map-portal-user',
	portalToken: 'admin:portal-token',
	backup: 'admin:backup',
	importData: 'admin:import'
} as const;
