export type ProviderFilter = 'all' | 'connected' | 'configured' | 'oauth' | 'disabled';

export type ProviderAuthPromptOption = {
	label: string;
	value: string;
	hint?: string;
};

export type ProviderAuthPrompt = {
	key: string;
	message: string;
	placeholder?: string;
	options?: ProviderAuthPromptOption[];
	when?: string;
};

export type ProviderAuthMethod = {
	index: number;
	type: 'oauth' | 'api';
	label: string;
	prompts: ProviderAuthPrompt[];
};

export type ProviderModelOption = {
	id: string;
	name: string;
};

export type ProviderOptionView = {
	baseURL?: string;
	headers?: Record<string, string>;
	timeout?: number;
	setCacheKey?: boolean;
	/** GitHub Copilot Enterprise URL (and similar provider-specific connect targets). */
	enterpriseUrl?: string;
};

export type ProviderView = {
	id: string;
	name: string;
	source: string;
	env: string[];
	connected: boolean;
	configured: boolean;
	disabled: boolean;
	activeMainModel: boolean;
	activeSmallModel: boolean;
	recommendedModelId: string;
	modelCount: number;
	models: ProviderModelOption[];
	authMethods: ProviderAuthMethod[];
	options: ProviderOptionView;
	supportsOauth: boolean;
	supportsApiAuth: boolean;
};

export type ProviderPageState = {
	available: boolean;
	error?: string;
	providers: ProviderView[];
	currentModel?: string;
	currentSmallModel?: string;
	stats: {
		total: number;
		connected: number;
		configured: number;
		disabled: number;
	};
	defaultModels: Record<string, string>;
	allowlistActive: boolean;
	providerCountLabel: string;
};

export type ProviderActionResult = {
	ok?: boolean;
	message?: string;
	selectedProviderId?: string;
	oauth?: {
		providerId: string;
		methodIndex: number;
		url: string;
		mode: 'auto' | 'code';
		instructions?: string;
		inputs?: Record<string, string>;
	};
};
