export type WizardConnectionType = 'cloud' | 'local';

export type WizardScreen =
  | 'welcome'
  | 'connections-hub'
  | 'connection-type'
  | 'add-connection-details'
  | 'models'
  | 'optional-addons'
  | 'review'
  | 'install'
  | 'deploying';

export const WIZARD_SCREEN_ORDER: WizardScreen[] = [
  'welcome',
  'connections-hub',
  'connection-type',
  'add-connection-details',
  'models',
  'optional-addons',
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

export type WizardAddonState = {
  enabled: boolean;
  connectionId: string;
  model: string;
};

export type WizardAssignments = {
  llm: {
    connectionId: string;
    model: string;
    smallModel: string;
  };
  embeddings: {
    connectionId: string;
    model: string;
    embeddingDims: number;
    sameAsLlm: boolean;
  };
  reranking: WizardAddonState & { mode: 'llm' | 'dedicated'; topN: number };
  tts: WizardAddonState & { voice: string; format: string };
  stt: WizardAddonState & { language: string };
};

export type SetupWizardDraft = {
  screen: WizardScreen;
  connections: WizardConnectionDraft[];
  editingConnectionIndex: number;
  assignments: WizardAssignments;
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
    screen: 'welcome',
    connections: [],
    editingConnectionIndex: 0,
    assignments: {
      llm: { connectionId: '', model: '', smallModel: '' },
      embeddings: { connectionId: '', model: '', embeddingDims: 1536, sameAsLlm: true },
      reranking: { enabled: false, connectionId: '', model: '', mode: 'llm', topN: 5 },
      tts: { enabled: false, connectionId: '', model: '', voice: '', format: '' },
      stt: { enabled: false, connectionId: '', model: '', language: '' },
    },
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

export function isAtOrAfterScreen(current: WizardScreen, target: WizardScreen): boolean {
  return WIZARD_SCREEN_ORDER.indexOf(current) >= WIZARD_SCREEN_ORDER.indexOf(target);
}

export function maxScreen(a: WizardScreen, b: WizardScreen): WizardScreen {
  return WIZARD_SCREEN_ORDER.indexOf(a) >= WIZARD_SCREEN_ORDER.indexOf(b) ? a : b;
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
