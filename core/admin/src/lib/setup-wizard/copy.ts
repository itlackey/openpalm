export const SETUP_WIZARD_COPY = {
  // ── existing keys (unchanged) ────────────────────────────────────────
  wizardHeaderTitle: 'OpenPalm Setup Wizard',
  wizardHeaderSubtitle: 'Configure your OpenPalm stack in a few steps.',
  connectionTypePrompt: 'Where are your models hosted?',
  selectModelsTitle: 'Required models',
  selectModelsDescription:
    'Choose the default chat, small, and embedding models OpenPalm should use first. You can change them later from the admin UI.',
  addAnotherConnection: 'Add connection',
  differentEmbeddingProvider: 'Use a different provider for embeddings?',
  connectionSummaryTitle: 'Configured Connections',
  llmConnectionLabel: 'Connection',
  embeddingConnectionLabel: 'Connection',

  // ── Screen 1: Welcome ─────────────────────────────────────────────────
  welcomeTitle: 'Welcome',
  welcomeBody:
    'Start with your name and an admin token. Then connect your models, choose defaults for chat and memory, and let OpenPalm bring the stack online for you.',
  welcomeStart: 'Start',
  welcomeSkip: 'Skip for now',

  // ── Screen 2: Connections Hub ─────────────────────────────────────────
  connectionsHubTitle: 'Connections',
  connectionsHubBody:
    'Connections are reusable model endpoints. Start with one, or mix local and remote providers if you want the best of both.',
  connectionsHubEmptyHeadline: 'No connections yet',
  connectionsHubEmptyBody:
    'Add a local model server like Ollama or LM Studio, or connect a hosted OpenAI-compatible provider.',
  connectionsHubEmptyCta: 'Add your first connection',
  connectionsHubAddBtn: 'Add connection',
  connectionsHubContinueBtn: 'Continue',

  // ── Screen 3: Add Connection Type ────────────────────────────────────
  addConnectionTypeTitle: 'Add a connection',

  // ── Screen 4: Add Connection Details ─────────────────────────────────
  addConnectionDetailsTitle: 'Connection details',
  addConnectionDetailsBody:
    'Give this connection a friendly name, confirm the endpoint details, and test it before saving.',
  addConnectionNameLabel: 'Connection name',
  addConnectionNamePlaceholder: 'e.g., "LM Studio local", "Work proxy", "OpenAI Prod"',
  addConnectionBaseUrlLabel: 'Base URL',
  addConnectionBaseUrlHint: 'Enter the server base URL without a trailing /v1 (OpenPalm adds /v1 automatically when needed).',
  addConnectionBaseUrlWarn:
    'Including /v1 in this URL may cause errors (for example, /v1/v1). Use the base URL without /v1.',
  addConnectionAuthToggle: 'This endpoint requires an API key',
  addConnectionApiKeyLabel: 'API key',
  addConnectionApiKeyPlaceholder: 'Paste your API key',
  addConnectionApiKeyHint:
    'Your key stays server-side and will be reused whenever this connection is selected.',
  addConnectionSaveBtn: 'Save connection',
  addConnectionCancelBtn: 'Cancel',
  testConnectionSuccess: 'Connection successful.',
  testConnectionFail: 'Connection failed. Check the Base URL and API key.',
  fetchModelsSuccess: 'Models loaded.',
  fetchModelsFail: "Couldn't load model list. You can still type model IDs manually.",

  // ── Screen 5: Required Models ─────────────────────────────────────────
  llmCardTitle: 'Chat model (LLM)',
  llmCardHelp: 'This model is used for responses and tool use in supported apps.',
  llmConnectionPlaceholder: 'Select a chat connection',
  llmSmallModelLabel: 'Small model (for lightweight tasks)',
  llmSmallModelHint: 'Use this for lightweight tasks. Memory uses this model by default during setup.',
  llmSmallModelPlaceholder: 'e.g., gpt-4.1-mini',
  embeddingsCardTitle: 'Embeddings',
  embeddingsCardHelp: 'Used for vector search / memory features.',
  embeddingConnectionPlaceholder: 'Select an embedding connection',
  embeddingsDimsLabel: 'Embedding dimensions',
  embeddingsDimsHint: "Only set this if you know your embedder's output dimensions.",
  embeddingsDimsPlaceholder: '1536',

  // ── Screen 6: Optional Add-ons ────────────────────────────────────────
  optionalAddonsTitle: 'Optional add-ons',
  optionalAddonsBody: 'Enable only what you want right now. Leaving everything off is perfectly fine.',
  rerankingToggleLabel: 'Enable reranking',
  rerankingToggleHelp: 'Improves search result relevance by re-ordering retrieved items.',
  rerankingTypeLabel: 'Reranker type',
  rerankingTypeLlm: 'Use an LLM to rerank',
  rerankingTypeDedicated: 'Use a dedicated reranker',
  ttsToggleLabel: 'Enable text-to-speech',
  ttsToggleHelp: 'Turns responses into audio.',
  sttToggleLabel: 'Enable speech-to-text',
  sttToggleHelp: 'Transcribes audio into text.',

  // ── Screen 7: Review ──────────────────────────────────────────────────
  reviewTitle: 'Review your setup',
  reviewBody: 'Confirm connections and model selections. You can edit anything before saving.',
  reviewSectionConnections: 'Connections',
  reviewSectionModels: 'Required models',
  reviewSectionAddons: 'Optional add-ons',
  reviewSaveBtn: 'Save',
} as const;
