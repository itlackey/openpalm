export type WizardConnectionType = 'cloud' | 'local';

export type WizardScreen =
  | 'token'
  | 'connection-type'
  | 'cloud-provider'
  | 'local-provider'
  | 'models'
  | 'review'
  | 'install'
  | 'deploying';

export const WIZARD_SCREEN_ORDER: WizardScreen[] = [
  'token',
  'connection-type',
  'cloud-provider',
  'local-provider',
  'models',
  'review',
  'install',
  'deploying',
];

export type WizardConnectionDraft = {
  id: string;
  name: string;
  connectionType: WizardConnectionType;
  provider: string;
  baseUrl: string;
  apiKey: string;
  tested: boolean;
  modelList: string[];
};

export type SetupWizardDraft = {
  screen: WizardScreen;
  connections: WizardConnectionDraft[];
  editingConnectionIndex: number;
  llmConnectionId: string;
  llmModel: string;
  llmSmallModel: string;
  embeddingConnectionId: string;
  embeddingModel: string;
  embeddingDims: number;
  memoryUserId: string;
};

export function createConnectionDraft(id?: string): WizardConnectionDraft {
  return {
    id: id ?? 'primary',
    name: '',
    connectionType: 'cloud',
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    tested: false,
    modelList: [],
  };
}

export function createInitialDraft(detectedUserId: string): SetupWizardDraft {
  return {
    screen: 'token',
    connections: [],
    editingConnectionIndex: 0,
    llmConnectionId: '',
    llmModel: '',
    llmSmallModel: '',
    embeddingConnectionId: '',
    embeddingModel: '',
    embeddingDims: 1536,
    memoryUserId: detectedUserId || 'default_user',
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
