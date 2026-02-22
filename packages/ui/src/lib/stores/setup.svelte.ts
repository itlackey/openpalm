export interface SetupState {
	completed: boolean;
	completedAt?: string;
	accessScope: 'host' | 'lan' | 'public';
	serviceInstances: {
		openmemory: string;
		psql: string;
		qdrant: string;
	};
	smallModel: {
		endpoint: string;
		modelId: string;
	};
	steps: Record<string, boolean>;
	enabledChannels: string[];
	openmemoryProvider?: {
		openaiBaseUrl: string;
		openaiApiKeyConfigured: boolean;
	};
	smallModelProvider?: {
		endpoint: string;
		modelId: string;
		apiKeyConfigured: boolean;
	};
	anthropicKeyConfigured?: boolean;
	firstBoot?: boolean;
}

let setupState = $state<SetupState | null>(null);
let wizardOpen = $state(false);
let wizardStep = $state(0);

export function getSetupState(): SetupState | null {
	return setupState;
}

export function setSetupState(state: SetupState | null) {
	setupState = state;
}

export function isWizardOpen(): boolean {
	return wizardOpen;
}

export function setWizardOpen(open: boolean) {
	wizardOpen = open;
}

export function getWizardStep(): number {
	return wizardStep;
}

export function setWizardStep(step: number) {
	wizardStep = step;
}
