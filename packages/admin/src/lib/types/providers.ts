export type ProviderFilter = 'all' | 'connected' | 'configured' | 'oauth' | 'disabled';

export interface ProviderAuthPrompt {
	key: string;
	message: string;
	placeholder?: string;
	options?: string[];
	when?: string;
}

export interface ProviderAuthMethod {
	index: number;
	type: 'oauth' | 'api';
	label: string;
	prompts: ProviderAuthPrompt[];
}

export interface ProviderModelOption {
	id: string;
	name: string;
}

export interface ProviderOptionView {
	apiKey?: string;
	baseURL?: string;
	headers?: Record<string, string>;
	timeout?: number;
	chunkTimeout?: number;
	setCacheKey?: boolean;
}

export interface ProviderView {
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
}

export interface ProviderPageState {
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
}

export interface ProviderActionResult {
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
}
