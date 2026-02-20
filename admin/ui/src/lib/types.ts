export type GalleryCategory =
	| 'plugin' | 'skill' | 'command' | 'agent'
	| 'tool' | 'channel' | 'service';

export type RiskLevel = 'lowest' | 'low' | 'medium' | 'medium-high' | 'highest';

export type GalleryItem = {
	id: string;
	name: string;
	description: string;
	category: GalleryCategory;
	risk: RiskLevel;
	author?: string;
	version?: string;
	source: string;
	tags?: string[];
	permissions?: string[];
	securityNotes?: string;
	installAction?: 'plugin' | 'skill-file' | 'command-file' | 'agent-file' | 'tool-file' | 'compose-service';
	installTarget: string;
	docUrl?: string;
	builtIn?: boolean;
};

export type RiskBadge = {
	label: string;
	color: string;
	description: string;
};

export type SmallModelConfig = {
	endpoint: string;
	modelId: string;
};

export type SetupState = {
	completed: boolean;
	completedAt?: string;
	accessScope: 'host' | 'lan';
	serviceInstances: {
		openmemory: string;
		psql: string;
		qdrant: string;
	};
	smallModel: SmallModelConfig;
	steps: {
		welcome: boolean;
		accessScope: boolean;
		serviceInstances: boolean;
		healthCheck: boolean;
		security: boolean;
		channels: boolean;
		extensions: boolean;
	};
	enabledChannels: string[];
	installedExtensions: string[];
};

export type Automation = {
	id: string;
	name: string;
	schedule: string;
	prompt: string;
	status: 'enabled' | 'disabled';
	createdAt: string;
};

export type ProviderConnection = {
	id: string;
	name: string;
	url: string;
	apiKey: string;
	createdAt: string;
};

export type ModelAssignment = 'small' | 'openmemory';

export type HealthResult = {
	ok: boolean;
	time?: string;
	error?: string;
};

export type ChannelInfo = {
	service: string;
	label: string;
	access: 'lan' | 'public';
	config: Record<string, string>;
	fields: ChannelField[];
};

export type ChannelField = {
	key: string;
	label: string;
	type: 'password' | 'text';
	required: boolean;
	helpText?: string;
};

export type ServiceMeta = {
	serviceNames: Record<string, { label: string; description: string }>;
	channelFields: Record<string, ChannelField[]>;
};

export type ApiResult<T = unknown> = {
	ok: boolean;
	status: number;
	data: T;
};
