export const SETUP_WIZARD_COPY = {
  // ── existing keys (unchanged) ────────────────────────────────────────
  wizardHeaderTitle: 'OpenPalm Setup Wizard',
  wizardHeaderSubtitle: 'Configure your OpenPalm stack in a few steps.',
  connectionTypePrompt: 'Where is this endpoint hosted?',
  selectModelsTitle: 'Required models',
  selectModelsDescription:
    'Choose a default chat model and a default embedding model. These can use different connections (local and remote).',
  addAnotherConnection: 'Add connection',
  differentEmbeddingProvider: 'Use a different provider for embeddings?',
  connectionSummaryTitle: 'Configured Connections',
  llmConnectionLabel: 'Connection',
  embeddingConnectionLabel: 'Connection',

  // ── Screen 1: Welcome ─────────────────────────────────────────────────
  welcomeTitle: 'Set up your models',
  welcomeBody:
    'Add one or more model connections (local and/or remote), then choose a default chat model and embedding model. You can optionally add reranking, text-to-speech, and speech-to-text later.',
  welcomeStart: 'Start',
  welcomeSkip: 'Skip for now',

  // ── Screen 2: Connections Hub ─────────────────────────────────────────
  connectionsHubTitle: 'Connections',
  connectionsHubBody:
    'Connections let you reuse the same endpoint (and credentials) across different model types. You can mix local and remote hosts.',
  connectionsHubEmptyHeadline: 'No connections yet',
  connectionsHubEmptyBody:
    'Add a connection to a local server (like LM Studio) or a remote OpenAI-compatible endpoint.',
  connectionsHubEmptyCta: 'Add your first connection',
  connectionsHubAddBtn: 'Add connection',
  connectionsHubContinueBtn: 'Continue',

  // ── Screen 3: Add Connection Type ────────────────────────────────────
  addConnectionTypeTitle: 'Add a connection',

  // ── Screen 4: Add Connection Details ─────────────────────────────────
  addConnectionDetailsTitle: 'Connection details',
  addConnectionDetailsBody:
    'Give this connection a name, point to the API endpoint, and add an API key if required.',
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
    'Your key will be stored securely and reused when you select this connection.',
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
  llmSmallModelHint: 'Optional cheaper model for small tasks.',
  llmSmallModelPlaceholder: 'e.g., gpt-4.1-mini',
  embeddingsCardTitle: 'Embeddings',
  embeddingsCardHelp: 'Used for vector search / memory features.',
  embeddingConnectionPlaceholder: 'Select an embedding connection',
  embeddingsSameAsLlm: 'Use same as Chat model',
  embeddingsAdvancedToggle: 'Advanced embedding settings',
  embeddingsDimsLabel: 'Embedding dimensions override',
  embeddingsDimsHint: "Only set this if you know your embedder's output dimensions.",
  embeddingsDimsPlaceholder: '1536',

  // ── Screen 6: Optional Add-ons ────────────────────────────────────────
  optionalAddonsTitle: 'Optional add-ons',
  optionalAddonsBody: 'Enable these only if you need them. You can set them up later.',
  rerankingToggleLabel: 'Enable reranking',
  rerankingToggleHelp: 'Improves search result relevance by re-ordering retrieved items.',
  rerankingTypeLabel: 'Reranker type',
  rerankingTypeLlm: 'Use an LLM to rerank',
  rerankingTypeDedicated: 'Use a dedicated reranker',
  ttsToggleLabel: 'Enable text-to-speech',
  ttsToggleHelp: 'Turns responses into audio.',
  sttToggleLabel: 'Enable speech-to-text',
  sttToggleHelp: 'Transcribes audio into text.',
  addonsSkipLink: 'Skip add-ons',

  // ── Screen 7: Review ──────────────────────────────────────────────────
  reviewTitle: 'Review your setup',
  reviewBody: 'Confirm connections and model selections. You can edit anything before saving.',
  reviewSectionConnections: 'Connections',
  reviewSectionModels: 'Required models',
  reviewSectionAddons: 'Optional add-ons',
  reviewSaveBtn: 'Save',
} as const;
