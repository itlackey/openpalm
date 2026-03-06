export type WizardConnectionType = 'cloud' | 'local' | null;

export type WizardScreen =
  | 'token'
  | 'connection-type'
  | 'cloud-provider'
  | 'local-provider'
  | 'models'
  | 'review'
  | 'install';

export const WIZARD_SCREEN_ORDER: WizardScreen[] = [
  'token',
  'connection-type',
  'cloud-provider',
  'local-provider',
  'models',
  'review',
  'install',
];

export type SetupWizardDraft = {
  screen: WizardScreen;
  connectionType: WizardConnectionType;
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  systemModel: string;
  embeddingModel: string;
  embeddingDims: number;
  openmemoryUserId: string;
};

export function createInitialDraft(detectedUserId: string): SetupWizardDraft {
  return {
    screen: 'token',
    connectionType: null,
    llmProvider: 'openai',
    llmBaseUrl: '',
    llmApiKey: '',
    systemModel: '',
    embeddingModel: '',
    embeddingDims: 1536,
    openmemoryUserId: detectedUserId || 'default_user',
  };
}

export function parseWizardScreen(value: string | null | undefined): WizardScreen | null {
  if (!value) return null;
  if (WIZARD_SCREEN_ORDER.includes(value as WizardScreen)) {
    return value as WizardScreen;
  }
  return null;
}

export function isAfterScreen(current: WizardScreen, target: WizardScreen): boolean {
  return WIZARD_SCREEN_ORDER.indexOf(current) > WIZARD_SCREEN_ORDER.indexOf(target);
}

export function nextScreen(screen: WizardScreen): WizardScreen {
  const index = WIZARD_SCREEN_ORDER.indexOf(screen);
  if (index < 0 || index === WIZARD_SCREEN_ORDER.length - 1) return screen;
  return WIZARD_SCREEN_ORDER[index + 1];
}

export function previousScreen(screen: WizardScreen): WizardScreen {
  const index = WIZARD_SCREEN_ORDER.indexOf(screen);
  if (index <= 0) return screen;
  return WIZARD_SCREEN_ORDER[index - 1];
}
