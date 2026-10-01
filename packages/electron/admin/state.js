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
		description: 'See what is running and choose how you want to use your agent.'
	},
	provider: {
		kicker: 'AI CONNECTION',
		title: 'AI account',
		description: 'Connect the account your agent uses and verify it can respond.'
	},
	connections: {
		kicker: 'CLIENTS & CHAT APPS',
		title: 'Connections',
		description: 'Choose which apps can reach your agent and how they are protected.'
	},
	access: {
		kicker: 'PEOPLE & PERMISSIONS',
		title: 'People & access',
		description: 'Give each person or app its own key and access level.'
	},
	backup: {
		kicker: 'PORTABLE RECOVERY',
		title: 'Backup',
		description: 'Protect your knowledge, workspace, preferences, and recurring work.'
	},
	diagnostics: {
		kicker: 'ADVANCED',
		title: 'Troubleshooting',
		description: 'Inspect network settings, local paths, and recent service logs.'
	}
};
