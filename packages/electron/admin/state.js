// Renderer-only state. Secrets remain transient and are never persisted here.
export function createAdminState() {
	return {
		api: null,
		currentConfig: null,
		currentSnapshot: null,
		currentView: 'overview',
		currentClient: 'opencode',
		providerSummaries: [],
		providersLoaded: false,
		providerLoadPromise: undefined,
		providerCatalogExpanded: false,
		automaticReadinessAttempted: false,
		activeOAuth: null,
		operationInFlight: false,
		disabledButtons: [],
		noticeTimer: undefined,
		importPreviewSignature: null,
		importPreviewDigest: null,
		lastReadiness: null,
		renderingSnapshot: false,
		dirtyForms: new Set()
	};
}

export const state = createAdminState();

export const managedFormIds = [
	'connections-form',
	'access-form',
	'network-form',
	'preferences-form'
];

export const commonProviders = new Set([
	'anthropic',
	'openai',
	'google',
	'github-copilot',
	'github',
	'opencode',
	'openrouter'
]);

export const policyLabels = {
	chat: 'Conversation only',
	read: 'Read files',
	full: 'Full control'
};

export const viewMeta = {
	overview: {
		kicker: 'PERSONAL AGENT',
		title: 'Your OpenPalm',
		description: 'Your agent and its connections, at a glance.'
	},
	provider: {
		kicker: 'AI CONNECTION',
		title: 'Agent settings',
		description: 'AI account, memory, and recurring work.'
	},
	connections: {
		kicker: 'CLIENTS & CHAT APPS',
		title: 'Connections',
		description: 'Connect an app or manage access from chat.'
	},
	access: {
		kicker: 'PEOPLE & PERMISSIONS',
		title: 'People & access',
		description: 'Give each person or app its own key and access level.'
	},
	system: {
		kicker: 'SYSTEM',
		title: 'System',
		description: 'Backups, logs, and installation details.'
	}
};
