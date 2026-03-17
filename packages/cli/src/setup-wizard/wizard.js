/**
 * OpenPalm Setup Wizard — Vanilla JS
 *
 * Self-contained wizard logic for the CLI-hosted setup flow.
 * No frameworks, no build step.
 */

/* =========================================================================
   Provider Constants (from packages/lib/src/provider-constants.ts)
   ========================================================================= */

const LLM_PROVIDERS = [
  'openai', 'anthropic', 'ollama', 'groq', 'together',
  'mistral', 'deepseek', 'xai', 'lmstudio', 'model-runner',
];

const PROVIDER_DEFAULT_URLS = {
  openai: 'https://api.openai.com',
  groq: 'https://api.groq.com/openai',
  mistral: 'https://api.mistral.ai',
  together: 'https://api.together.xyz',
  deepseek: 'https://api.deepseek.com',
  xai: 'https://api.x.ai',
  lmstudio: 'http://host.docker.internal:1234',
  ollama: 'http://host.docker.internal:11434',
  'model-runner': 'http://model-runner.docker.internal/engines',
};

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  groq: 'Groq',
  together: 'Together AI',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI (Grok)',
  lmstudio: 'LM Studio',
  'model-runner': 'Docker Model Runner',
};

const EMBEDDING_DIMS = {
  'openai/text-embedding-3-small': 1536,
  'openai/text-embedding-3-large': 3072,
  'openai/text-embedding-ada-002': 1536,
  'ollama/nomic-embed-text': 768,
  'ollama/mxbai-embed-large': 1024,
  'ollama/all-minilm': 384,
  'ollama/snowflake-arctic-embed': 1024,
};

const PROVIDER_KEY_MAP = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  google: 'GOOGLE_API_KEY',
};

const OLLAMA_DEFAULT_MODELS = {
  chat: 'llama3.2:latest',
  embedding: 'nomic-embed-text',
};

const CLOUD_PROVIDERS = ['openai', 'groq', 'together', 'mistral', 'deepseek', 'xai', 'anthropic'];
const LOCAL_PROVIDERS = ['ollama', 'lmstudio', 'model-runner'];

/* =========================================================================
   Wizard Copy / Text
   ========================================================================= */

const COPY = {
  wizardHeaderTitle: 'OpenPalm Setup Wizard',
  wizardHeaderSubtitle: 'Configure your OpenPalm stack in a few steps.',

  welcomeTitle: 'Welcome',
  welcomeBody: 'Start with your name and an admin token. Then connect your models, choose defaults for chat and memory, and let OpenPalm bring the stack online for you.',
  welcomeStart: 'Start',

  connectionsHubTitle: 'Connections',
  connectionsHubBody: 'Connections are reusable model endpoints. Start with one, or mix local and remote providers if you want the best of both.',
  connectionsHubEmptyHeadline: 'No connections yet',
  connectionsHubEmptyBody: 'Add a local model server like Ollama or LM Studio, or connect a hosted OpenAI-compatible provider.',
  connectionsHubEmptyCta: 'Add your first connection',
  connectionsHubAddBtn: 'Add connection',
  connectionsHubContinueBtn: 'Continue',

  addConnectionTypeTitle: 'Add a connection',
  connectionTypePrompt: 'Where are your models hosted?',

  addConnectionDetailsTitle: 'Connection details',
  addConnectionDetailsBody: 'Give this connection a friendly name, confirm the endpoint details, and test it before saving.',
  addConnectionNameLabel: 'Connection name',
  addConnectionNamePlaceholder: 'e.g., "LM Studio local", "Work proxy", "OpenAI Prod"',
  addConnectionBaseUrlLabel: 'Base URL',
  addConnectionBaseUrlHint: 'Enter the server base URL without a trailing /v1 (OpenPalm adds /v1 automatically when needed).',
  addConnectionBaseUrlWarn: 'Including /v1 in this URL may cause errors (for example, /v1/v1). Use the base URL without /v1.',
  addConnectionApiKeyLabel: 'API key',
  addConnectionApiKeyPlaceholder: 'Paste your API key',
  addConnectionApiKeyHint: 'Your key stays server-side and will be reused whenever this connection is selected.',
  addConnectionSaveBtn: 'Save connection',
  addConnectionCancelBtn: 'Cancel',
  testConnectionSuccess: 'Connection successful.',
  testConnectionFail: "Connection failed. Check the Base URL and API key.",

  selectModelsTitle: 'Required models',
  selectModelsDescription: 'Choose the default chat, small, and embedding models OpenPalm should use first. You can change them later from the admin UI.',
  llmCardTitle: 'Chat model (LLM)',
  llmCardHelp: 'This model is used for responses and tool use in supported apps.',
  llmConnectionLabel: 'Connection',
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
  addAnotherConnection: 'Add connection',
  differentEmbeddingProvider: 'Use a different provider for embeddings?',

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

  reviewTitle: 'Review your setup',
  reviewBody: 'Confirm connections and model selections. You can edit anything before saving.',
  reviewSectionConnections: 'Connections',
  reviewSectionModels: 'Required models',
  reviewSectionAddons: 'Optional add-ons',
  reviewSaveBtn: 'Save & Install',
};

/* =========================================================================
   Screen Flow
   ========================================================================= */

const SCREEN_ORDER = [
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

// Map screens to step indicator index (0-5)
const SCREEN_TO_STEP = {
  'welcome': 0,
  'connections-hub': 1,
  'connection-type': 2,
  'add-connection-details': 2,
  'models': 3,
  'optional-addons': 4,
  'review': 5,
  'install': 5,
  'deploying': -1, // no indicator
};

/* =========================================================================
   Wizard State
   ========================================================================= */

const state = {
  screen: 'welcome',
  furthestScreen: 'welcome',

  // Welcome fields
  ownerName: '',
  ownerEmail: '',
  adminToken: '',
  setupSessionToken: '',

  // Connections
  connections: [],
  editingConnectionIndex: -1,
  draftConnectionIndex: null,

  // Model assignments
  assignments: {
    llm: { connectionId: '', model: '', smallModel: '' },
    embeddings: { connectionId: '', model: '', embeddingDims: 1536, sameAsLlm: true },
    reranking: { enabled: false, connectionId: '', model: '', mode: 'llm', topN: 5 },
    tts: { enabled: false, connectionId: '', model: '', voice: '', format: '' },
    stt: { enabled: false, connectionId: '', model: '', language: '' },
  },

  memoryUserId: 'default_user',
  ollamaEnabled: false,

  // Local provider detection
  detectedProviders: [],
  detectingProviders: false,
  providersDetected: false,

  // Ollama enable
  enablingOllama: false,
  ollamaEnableError: '',
  ollamaEnableProgress: '',

  // Install/deploy
  installing: false,
  installError: '',
  startedServices: [],

  // Deploy polling
  deployPhase: null,
  deployMessage: '',
  deployServices: [],
  deployError: '',
};

let autoTestTimer = null;
let deployPollTimer = null;
let ollamaPollTimer = null;

/* =========================================================================
   Helper Functions
   ========================================================================= */

function screenIndex(s) { return SCREEN_ORDER.indexOf(s); }
function isAfterScreen(current, target) { return screenIndex(current) > screenIndex(target); }
function isAtOrAfterScreen(current, target) { return screenIndex(current) >= screenIndex(target); }
function maxScreen(a, b) { return screenIndex(a) >= screenIndex(b) ? a : b; }

function generateId() { return Math.random().toString(36).slice(2, 10); }

function generateAdminToken() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function getConnectionById(id) { return state.connections.find(c => c.id === id); }

function getConnectionNameById(id) {
  const c = getConnectionById(id);
  return c ? (c.name || PROVIDER_LABELS[c.provider] || c.provider) : 'No connection selected';
}

function maskedKey(key) {
  return key ? key.slice(0, 3) + '...' + key.slice(-4) : '(not set)';
}

function formatModelReview(model, connectionId) {
  if (!model || !model.trim()) return 'Not configured';
  return `${model} (${getConnectionNameById(connectionId)})`;
}

function getEffectiveMemoryModel() {
  return (state.assignments.llm.smallModel || '').trim() || (state.assignments.llm.model || '').trim();
}

function formatAddonReview(enabled, connectionId, parts) {
  if (!enabled) return 'Disabled';
  const detail = parts.filter(Boolean).join(' / ');
  return detail ? `${detail} (${getConnectionNameById(connectionId)})` : `Enabled (${getConnectionNameById(connectionId)})`;
}

/* ── Embedding / model selection helpers ─────────────────────────────── */

function resolveEmbeddingDims(provider, model) {
  if (!provider || !model) return null;
  const exact = EMBEDDING_DIMS[`${provider}/${model}`];
  if (exact) return exact;
  const withoutTag = model.replace(/:[^/]+$/, '');
  const canonical = EMBEDDING_DIMS[`${provider}/${withoutTag}`];
  if (canonical) return canonical;
  const prefixMatch = Object.entries(EMBEDDING_DIMS).find(([key]) => {
    const [kp, km] = key.split('/', 2);
    return kp === provider && (model === km || model.startsWith(`${km}:`));
  });
  return prefixMatch ? prefixMatch[1] : null;
}

function isEmbeddingLikeModel(model) {
  return /embed|embedding|bge|e5|nomic|minilm|mxbai|arctic|ada/i.test(model);
}

function isNonChatModel(model) {
  return /embed|embedding|rerank|tts|whisper|stt|transcribe|vision|moderation/i.test(model);
}

function pickPreferredChatModel(connection, models) {
  if (models.length === 0) return '';
  if (connection.provider === 'ollama') {
    const ollamaDefault = models.find(m => m === OLLAMA_DEFAULT_MODELS.chat || m.startsWith(`${OLLAMA_DEFAULT_MODELS.chat}:`));
    if (ollamaDefault) return ollamaDefault;
  }
  const chatLike = models.find(m => !isNonChatModel(m));
  return chatLike || models[0];
}

function pickPreferredSmallModel(models, chatModel) {
  if (chatModel && models.includes(chatModel)) return chatModel;
  return chatModel || models[0] || '';
}

function pickPreferredEmbeddingModel(connection, models) {
  if (models.length === 0) return { model: '', dims: 1536 };
  const exactKnown = models.find(m => resolveEmbeddingDims(connection.provider, m) !== null);
  const embeddingLike = models.find(m => isEmbeddingLikeModel(m));
  const chosen = exactKnown || embeddingLike || models[0];
  return {
    model: chosen,
    dims: resolveEmbeddingDims(connection.provider, chosen) || 1536,
  };
}

function getEmbeddingModelOptions(connection, models, currentModel) {
  if (models.length === 0) return [];
  const filtered = models.filter(m => {
    if (!connection) return isEmbeddingLikeModel(m);
    return resolveEmbeddingDims(connection.provider, m) !== null || isEmbeddingLikeModel(m);
  });
  if (filtered.length === 0) return models;
  if (currentModel && !filtered.includes(currentModel) && models.includes(currentModel)) {
    return [currentModel, ...filtered];
  }
  return filtered;
}

function applySuggestedAssignmentsForConnection(connection) {
  const chatModel = pickPreferredChatModel(connection, connection.modelList);
  const smallModel = pickPreferredSmallModel(connection.modelList, chatModel);
  const embedding = pickPreferredEmbeddingModel(connection, connection.modelList);

  state.assignments.llm.connectionId = connection.id;
  state.assignments.llm.model = chatModel || state.assignments.llm.model;
  state.assignments.llm.smallModel = smallModel || state.assignments.llm.smallModel;
  state.assignments.embeddings.connectionId = connection.id;
  state.assignments.embeddings.model = embedding.model || state.assignments.embeddings.model;
  state.assignments.embeddings.embeddingDims = embedding.dims || state.assignments.embeddings.embeddingDims;
  state.assignments.embeddings.sameAsLlm = false;
}

/* ── Connection test error mapping ───────────────────────────────────── */

function mapConnectionTestError(result) {
  switch (result.errorCode) {
    case 'unauthorized':
      return 'Invalid API key. The provider rejected the credentials.';
    case 'not_found':
      return 'Endpoint not found. Verify the Base URL is correct.';
    case 'timeout':
      return "Couldn't reach the server. Confirm it's running and accessible.";
    case 'network':
      return 'Unable to connect to the provider. Verify the base URL.';
    case 'missing_base_url':
      return 'Base URL is required for this provider.';
    default:
      return result.error || 'Connection failed. Check the Base URL and API key.';
  }
}

/* ── Deploy helpers ──────────────────────────────────────────────────── */

function getDeployProgress(services) {
  if (services.length === 0) return 0;
  let total = 0;
  for (const svc of services) {
    if (svc.containerRunning) total += 1;
    else if (svc.imageReady) total += 0.7;
  }
  return Math.round((total / services.length) * 100);
}

function getDeployStatusText(svc) {
  if (svc.containerRunning) return 'Running';
  if (state.deployPhase === 'error' && svc.imageReady) return 'Image pulled, startup stopped';
  if (state.deployPhase === 'starting' && svc.imageReady) return 'Starting container...';
  if (svc.imageReady) return 'Image ready';
  return 'Pulling image...';
}

function summarizeDeployError(error) {
  if (!error || !error.trim()) return 'Deployment failed.';
  if (/error mounting/i.test(error)) return 'A generated stack mount does not match the expected file or directory type.';
  if (/docker is not available/i.test(error)) return 'Docker is unavailable on this host.';
  const daemonMatch = error.match(/Error response from daemon:\s*([^\n]+)$/i);
  if (daemonMatch && daemonMatch[1]) {
    const msg = daemonMatch[1].trim();
    return msg.length > 180 ? msg.slice(0, 177) + '...' : msg;
  }
  return error.length > 240 ? error.slice(0, 237) + '...' : error;
}

function getDeployTipList() {
  const tips = {
    pulling: [
      'First startup is the slowest because container images still need to download.',
      'You can keep this tab open while the stack comes online.',
      'If a provider is local, make sure it is still running on this machine.',
    ],
    starting: [
      'OpenPalm is wiring services together on the internal Docker network.',
      'The console will be available as soon as the core services finish starting.',
      'Model downloads can continue in your provider separately after setup completes.',
    ],
    ready: [
      'Your core services are online and ready.',
      'You can revisit Connections later to swap models or add more providers.',
      'If memory embeddings ever change, reset the collection before re-indexing.',
    ],
    error: [
      'Review the error first, then return to the previous step to adjust settings.',
      'Local providers should stay reachable from the OpenPalm host during startup.',
      'You can rerun setup after fixing Docker or provider issues.',
    ],
  };
  return tips[state.deployPhase] || [
    'OpenPalm will validate your selections and then start the stack for you.',
    'A single good chat connection is enough to get started quickly.',
  ];
}

/* ── Connection mode summary ─────────────────────────────────────────── */

function getConnectionModeSummary(type) {
  if (type === 'local') {
    return {
      title: 'Local connection',
      body: 'Best for Ollama, LM Studio, and Docker Model Runner running on this machine or your LAN.',
      bullets: [
        'Usually does not need an API key.',
        'We try to detect running local providers automatically.',
        'Use a localhost or LAN address that this host can reach.',
      ],
    };
  }
  return {
    title: 'Remote connection',
    body: 'Best for hosted providers, gateways, and work proxies that expose an OpenAI-compatible API.',
    bullets: [
      'Usually requires an API key.',
      'We prefill the base URL using the selected provider when possible.',
      'Good for OpenAI, Groq, Together, Mistral, and hosted proxies.',
    ],
  };
}

/* ── Validation ──────────────────────────────────────────────────────── */

function validateConnectionFields() {
  const conn = state.connections[state.editingConnectionIndex];
  if (!conn) return 'No connection being edited.';
  if (!conn.provider) return 'Select a provider before continuing.';
  if (conn.connectionType === 'cloud' && !conn.apiKey.trim() && conn.provider !== 'anthropic') {
    return 'API key is required for cloud providers.';
  }
  if (conn.connectionType === 'local' && !conn.baseUrl.trim()) {
    return 'Base URL is required for local providers.';
  }
  return '';
}

/* =========================================================================
   API Calls
   ========================================================================= */

function buildHeaders(token) {
  const h = {
    'x-requested-by': 'ui',
    'x-request-id': crypto.randomUUID(),
  };
  if (token) h['x-admin-token'] = token;
  return h;
}

async function apiDetectProviders() {
  try {
    const res = await fetch('/api/setup/detect-providers', {
      headers: buildHeaders(state.setupSessionToken),
    });
    if (res.ok) {
      const data = await res.json();
      return data.providers || [];
    }
  } catch { /* ignore */ }
  return [];
}

async function apiTestConnection(conn) {
  const res = await fetch('/api/setup/test-connection', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...buildHeaders(state.setupSessionToken),
    },
    body: JSON.stringify({
      baseUrl: conn.baseUrl,
      apiKey: conn.apiKey,
      kind: conn.connectionType === 'local' ? 'local' : 'cloud',
    }),
  });
  return res.json();
}

async function apiFetchModels(provider, baseUrl, apiKey) {
  const params = new URLSearchParams();
  if (baseUrl) params.set('baseUrl', baseUrl);
  if (apiKey) params.set('apiKey', apiKey);
  const res = await fetch(`/api/setup/models/${encodeURIComponent(provider)}?${params}`, {
    headers: buildHeaders(state.setupSessionToken),
  });
  if (res.ok) {
    const data = await res.json();
    return data.models || [];
  }
  return [];
}

async function apiEnableOllama() {
  const res = await fetch('/api/setup/enable-ollama', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...buildHeaders(state.setupSessionToken),
    },
  });
  return res.json();
}

async function apiPollOllamaStatus() {
  const res = await fetch('/api/setup/ollama-status', {
    headers: buildHeaders(state.setupSessionToken),
  });
  if (res.ok) return res.json();
  return null;
}

async function apiInstall() {
  const a = state.assignments;
  const payload = {
    adminToken: state.adminToken,
    ownerName: state.ownerName,
    ownerEmail: state.ownerEmail,
    connections: state.connections.map(c => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
    })),
    assignments: {
      llm: {
        connectionId: a.llm.connectionId,
        model: a.llm.model,
        ...(a.llm.smallModel ? { smallModel: a.llm.smallModel } : {}),
      },
      embeddings: {
        connectionId: a.embeddings.connectionId,
        model: a.embeddings.model,
        embeddingDims: a.embeddings.embeddingDims,
      },
      ...(a.reranking.enabled ? {
        reranking: {
          enabled: true,
          connectionId: a.reranking.connectionId,
          model: a.reranking.model,
          mode: a.reranking.mode,
          topN: a.reranking.topN,
        },
      } : {}),
      ...(a.tts.enabled ? {
        tts: {
          enabled: true,
          connectionId: a.tts.connectionId,
          model: a.tts.model,
          voice: a.tts.voice,
          format: a.tts.format,
        },
      } : {}),
      ...(a.stt.enabled ? {
        stt: {
          enabled: true,
          connectionId: a.stt.connectionId,
          model: a.stt.model,
          language: a.stt.language,
        },
      } : {}),
    },
    memoryUserId: state.memoryUserId,
    ollamaEnabled: state.ollamaEnabled,
  };

  const res = await fetch('/api/setup/complete', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...buildHeaders(state.setupSessionToken),
    },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

async function apiPollDeployStatus() {
  try {
    const res = await fetch('/api/setup/deploy-status', {
      headers: buildHeaders(state.setupSessionToken),
    });
    if (res.ok) return res.json();
  } catch { /* ignore */ }
  return null;
}

/* =========================================================================
   SVG Icons (inline)
   ========================================================================= */

const SVG_CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_CHECK_CIRCLE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const SVG_CHECK_CIRCLE_LARGE = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const SVG_CLOUD = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
const SVG_SERVER = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="18" r="1" fill="currentColor" stroke="none"/></svg>';
const SVG_CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const SVG_WARNING = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>';
const SVG_CHECK_18 = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_CHECK_10 = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/* =========================================================================
   DOM Helpers
   ========================================================================= */

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }
function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') e.className = v;
      else if (k === 'innerHTML') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'disabled') { if (v) e.disabled = true; }
      else if (k === 'checked') { if (v) e.checked = true; }
      else if (k === 'selected') { if (v) e.selected = true; }
      else if (k === 'htmlFor') e.htmlFor = v;
      else if (k === 'dataset') { for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv; }
      else e.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === 'string') e.appendChild(document.createTextNode(child));
    else if (Array.isArray(child)) child.forEach(c => { if (c) e.appendChild(c); });
    else e.appendChild(child);
  }
  return e;
}

/* =========================================================================
   Screen Navigation
   ========================================================================= */

function goToScreen(next) {
  state.screen = next;
  state.furthestScreen = maxScreen(state.furthestScreen, next);
  const url = new URL(window.location.href);
  url.searchParams.set('screen', next);
  window.history.replaceState({}, '', url);
  render();
}

/* =========================================================================
   Connection Management
   ========================================================================= */

function startNewConnection() {
  const id = state.connections.length === 0 ? 'primary' : generateId();
  const draft = {
    id,
    name: '',
    connectionType: 'cloud',
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    tested: false,
    modelList: [],
  };
  state.connections.push(draft);
  state.editingConnectionIndex = state.connections.length - 1;
  state.draftConnectionIndex = state.editingConnectionIndex;
  goToScreen('connection-type');
}

function selectConnectionType(type) {
  const idx = state.editingConnectionIndex;
  const conn = state.connections[idx];
  if (!conn) return;
  conn.connectionType = type;
  conn.tested = false;
  conn.modelList = [];
  conn.provider = type === 'cloud' ? 'openai' : 'ollama';
  conn.baseUrl = type === 'cloud' ? (PROVIDER_DEFAULT_URLS['openai'] || '') : (PROVIDER_DEFAULT_URLS['ollama'] || '');
  conn.apiKey = '';
  if (type === 'local') detectLocalProviders();
  goToScreen('add-connection-details');
}

function handleProviderChange(newProvider) {
  const idx = state.editingConnectionIndex;
  const conn = state.connections[idx];
  if (!conn) return;
  const detected = state.detectedProviders.find(p => p.provider === newProvider && p.available);
  let baseUrl = conn.baseUrl;
  if (detected) {
    baseUrl = detected.url;
  } else if (!baseUrl || Object.values(PROVIDER_DEFAULT_URLS).includes(baseUrl)) {
    baseUrl = PROVIDER_DEFAULT_URLS[newProvider] || '';
  }
  conn.provider = newProvider;
  conn.baseUrl = baseUrl;
  conn.name = PROVIDER_LABELS[newProvider] || newProvider;
  conn.tested = false;
  conn.modelList = [];
  if (detected && detected.available) {
    scheduleAutoTest();
  }
  render();
}

function scheduleAutoTest() {
  if (autoTestTimer) clearTimeout(autoTestTimer);
  autoTestTimer = setTimeout(() => {
    const conn = state.connections[state.editingConnectionIndex];
    if (conn && !conn.tested) {
      const err = validateConnectionFields();
      if (!err) testConnection();
    }
  }, 800);
}

function finalizeConnection() {
  const idx = state.editingConnectionIndex;
  const conn = state.connections[idx];
  if (!conn) return;
  if (!conn.name) conn.name = PROVIDER_LABELS[conn.provider] || conn.provider;
  if (state.connections.length === 1) {
    applySuggestedAssignmentsForConnection(conn);
  }
  state.draftConnectionIndex = null;
  state.editingConnectionIndex = -1;
  goToScreen('connections-hub');
}

function editConnection(index) {
  state.editingConnectionIndex = index;
  state.draftConnectionIndex = null;
  goToScreen('add-connection-details');
}

function duplicateConnection(index) {
  const source = state.connections[index];
  if (!source) return;
  const copy = {
    ...JSON.parse(JSON.stringify(source)),
    id: generateId(),
    name: source.name ? `${source.name} (copy)` : '',
    tested: false,
    modelList: [],
  };
  state.connections.push(copy);
  state.editingConnectionIndex = state.connections.length - 1;
  state.draftConnectionIndex = state.editingConnectionIndex;
  goToScreen('add-connection-details');
}

function removeConnection(index) {
  const removed = state.connections[index];
  state.connections.splice(index, 1);
  if (removed && state.assignments.llm.connectionId === removed.id) {
    state.assignments.llm.connectionId = '';
    state.assignments.llm.model = '';
  }
  if (removed && state.assignments.embeddings.connectionId === removed.id) {
    state.assignments.embeddings.connectionId = '';
    state.assignments.embeddings.model = '';
  }
  render();
}

/* =========================================================================
   API-driven actions
   ========================================================================= */

async function detectLocalProviders() {
  state.detectingProviders = true;
  render();
  const providers = await apiDetectProviders();
  state.detectedProviders = providers;
  state.detectingProviders = false;
  state.providersDetected = true;
  const ollamaDetected = providers.find(p => p.provider === 'ollama' && p.available);
  if (ollamaDetected) {
    handleProviderChange('ollama');
  }
  render();
}

async function testConnection(connOverride) {
  const conn = connOverride || state.connections[state.editingConnectionIndex];
  if (!conn) return;
  state.installing = false; // reuse field to track test state
  render();
  try {
    const result = await apiTestConnection(conn);
    if (!result.ok && result.errorCode) {
      showConnError(mapConnectionTestError(result));
      return;
    }
    if (!result.ok) {
      showConnError(result.error || COPY.testConnectionFail);
      return;
    }
    const apiModels = result.models || [];
    const idx = state.connections.findIndex(c => c.id === conn.id);
    if (idx >= 0) {
      const merged = new Set(apiModels);
      if (state.assignments.llm.model && conn.id === state.assignments.llm.connectionId) merged.add(state.assignments.llm.model);
      if (state.assignments.embeddings.model && conn.id === state.assignments.embeddings.connectionId) merged.add(state.assignments.embeddings.model);
      const sorted = [...merged].sort();
      state.connections[idx].tested = true;
      state.connections[idx].modelList = sorted;
      if (sorted.length > 0) {
        const isFirst = state.connections.length === 1;
        const ownsLlm = conn.id === state.assignments.llm.connectionId;
        const ownsEmb = conn.id === state.assignments.embeddings.connectionId;
        if (isFirst || (!state.assignments.llm.model && ownsLlm) || (!state.assignments.embeddings.model && ownsEmb)) {
          applySuggestedAssignmentsForConnection(state.connections[idx]);
        }
      }
    }
  } catch {
    showConnError('Network error — unable to reach the setup server.');
  }
  render();
}

function showConnError(msg) {
  const errEl = $('#conn-error');
  if (errEl) {
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  }
}

async function enableOllama() {
  if (state.enablingOllama) return;
  state.enablingOllama = true;
  state.ollamaEnableError = '';
  state.ollamaEnableProgress = 'Adding Ollama to the stack...';
  render();
  try {
    const result = await apiEnableOllama();
    if (!result || result.error) {
      state.ollamaEnableError = (result && result.message) || 'Failed to enable Ollama.';
      state.enablingOllama = false;
      state.ollamaEnableProgress = '';
      render();
      return;
    }
    state.ollamaEnableProgress = result.message || 'Enabling Ollama in background...';
    if (ollamaPollTimer) clearInterval(ollamaPollTimer);
    ollamaPollTimer = setInterval(pollOllamaStatus, 3000);
    render();
  } catch {
    state.ollamaEnableError = 'Network error — unable to reach setup server.';
    state.enablingOllama = false;
    state.ollamaEnableProgress = '';
    render();
  }
}

async function pollOllamaStatus() {
  const data = await apiPollOllamaStatus();
  if (!data || !data.active) return;
  state.ollamaEnableProgress = data.message || 'Enabling Ollama...';
  if (data.phase === 'done') {
    if (ollamaPollTimer) { clearInterval(ollamaPollTimer); ollamaPollTimer = null; }
    applyOllamaResult(data);
    state.enablingOllama = false;
    state.ollamaEnableProgress = '';
    const conn = state.connections[state.editingConnectionIndex];
    if (conn) {
      state.assignments.llm.connectionId = conn.id;
      state.assignments.embeddings.connectionId = conn.id;
    }
    finalizeConnection();
  } else if (data.phase === 'error') {
    if (ollamaPollTimer) { clearInterval(ollamaPollTimer); ollamaPollTimer = null; }
    state.ollamaEnableError = data.message || 'Ollama enable failed.';
    state.enablingOllama = false;
    state.ollamaEnableProgress = '';
    render();
  } else {
    render();
  }
}

function applyOllamaResult(result) {
  const conn = state.connections[state.editingConnectionIndex];
  if (!conn) return;
  state.ollamaEnabled = true;
  const ollamaUrl = result.ollamaUrl || 'http://ollama:11434';
  const pulledModels = [];
  const failedModels = [];
  if (result.models) {
    for (const [name, status] of Object.entries(result.models)) {
      if (status.ok) pulledModels.push(name); else failedModels.push(name);
    }
  }
  conn.provider = 'ollama';
  conn.baseUrl = ollamaUrl;
  conn.tested = true;
  conn.modelList = pulledModels.sort();
  conn.name = 'Ollama';
  if (pulledModels.length > 0) {
    const defaultChat = result.defaultChatModel || OLLAMA_DEFAULT_MODELS.chat;
    const defaultEmbed = result.defaultEmbeddingModel || OLLAMA_DEFAULT_MODELS.embedding;
    state.assignments.llm.model = defaultChat;
    state.assignments.embeddings.model = defaultEmbed;
    state.assignments.embeddings.embeddingDims = EMBEDDING_DIMS[`ollama/${defaultEmbed}`] || 768;
  }
  if (failedModels.length > 0) {
    state.ollamaEnableError = `Ollama is running but failed to pull: ${failedModels.join(', ')}.`;
  }
}

async function handleInstall() {
  if (state.installing) return;
  state.installing = true;
  state.installError = '';
  render();
  try {
    const { ok, data } = await apiInstall();
    if (!ok) {
      state.installError = data.message || 'Install failed.';
      state.installing = false;
      render();
      return;
    }
    state.startedServices = data.started || [];
    state.setupSessionToken = state.adminToken;
    goToScreen('deploying');
    startDeployPolling();
  } catch {
    state.installError = 'Network error — unable to reach setup server.';
    state.installing = false;
    render();
  }
}

function startDeployPolling() {
  stopDeployPolling();
  pollDeployStatus();
  deployPollTimer = setInterval(pollDeployStatus, 2000);
}

function stopDeployPolling() {
  if (deployPollTimer) { clearInterval(deployPollTimer); deployPollTimer = null; }
}

async function pollDeployStatus() {
  const data = await apiPollDeployStatus();
  if (!data || !data.active) return;
  state.deployPhase = data.phase;
  state.deployMessage = data.message || '';
  state.deployServices = data.services || [];
  if (data.phase === 'ready') {
    stopDeployPolling();
    state.installing = false;
  } else if (data.phase === 'error') {
    stopDeployPolling();
    state.deployError = data.error || data.message || 'Deployment failed.';
    state.installing = false;
  }
  render();
}

function resetDeployUiState() {
  state.deployPhase = null;
  state.deployError = '';
  state.deployServices = [];
  state.deployMessage = '';
  state.installing = false;
}

/* =========================================================================
   Render: Build a model selector (select or text input)
   ========================================================================= */

function renderModelSelector(id, value, options, placeholder, onChange) {
  if (options.length > 0) {
    const s = el('select', { id, className: 'model-select' });
    for (const opt of options) {
      const o = el('option', { value: opt }, opt);
      if (opt === value) o.selected = true;
      s.appendChild(o);
    }
    s.addEventListener('change', (e) => onChange(e.target.value));
    // Auto-select first if no value
    if (!value && options.length > 0) {
      setTimeout(() => onChange(options[0]), 0);
    }
    return s;
  }
  const inp = el('input', { id, type: 'text', value: value || '', placeholder });
  inp.addEventListener('input', (e) => onChange(e.target.value));
  return inp;
}

function renderConnectionSelect(id, selectedId, placeholderText, onChange) {
  const s = el('select', { id });
  s.appendChild(el('option', { value: '', disabled: true, selected: !selectedId }, placeholderText));
  for (const conn of state.connections) {
    const o = el('option', { value: conn.id }, conn.name || conn.provider);
    if (conn.id === selectedId) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', (e) => onChange(e.target.value));
  return s;
}

/* =========================================================================
   Render: Step Indicators
   ========================================================================= */

function renderStepIndicators() {
  const nav = el('nav', { className: 'step-indicators', 'aria-label': 'Wizard steps' });
  const stepLabels = ['Welcome', 'Connections', 'Add Connection', 'Models', 'Add-ons', 'Review'];
  const stepScreens = ['welcome', 'connections-hub', 'connection-type', 'models', 'optional-addons', 'review'];

  for (let i = 0; i < stepLabels.length; i++) {
    if (i > 0) {
      const line = el('span', { className: 'step-line' + (isAfterScreen(state.furthestScreen, stepScreens[i - 1]) ? ' active' : '') });
      nav.appendChild(line);
    }
    const currentStep = SCREEN_TO_STEP[state.screen];
    const isActive = currentStep === i;
    const isCompleted = isAfterScreen(state.furthestScreen, stepScreens[i]);
    const canClick = isAtOrAfterScreen(state.furthestScreen, stepScreens[i]);

    const classes = ['step-dot'];
    if (isActive) classes.push('active');
    if (isCompleted && !isActive) classes.push('completed');

    const dot = el('button', {
      className: classes.join(' '),
      disabled: !canClick,
      'aria-label': `Step ${i + 1}: ${stepLabels[i]}`,
      ...(isActive ? { 'aria-current': 'step' } : {}),
    });

    if (isCompleted && !isActive) {
      dot.innerHTML = SVG_CHECK;
    } else {
      dot.textContent = String(i + 1);
    }

    dot.addEventListener('click', () => {
      if (!canClick) return;
      if (i === 2 && state.connections.length > 0) {
        state.editingConnectionIndex = 0;
        goToScreen('add-connection-details');
      } else {
        goToScreen(stepScreens[i]);
      }
    });

    nav.appendChild(dot);
  }
  return nav;
}

/* =========================================================================
   Render: Individual Screens
   ========================================================================= */

function renderWelcomeScreen() {
  const content = el('div', { className: 'step-content', dataset: { testid: 'step-welcome' } });

  content.appendChild(el('h2', null, COPY.welcomeTitle));
  content.appendChild(el('p', { className: 'step-description' }, COPY.welcomeBody));

  // Setup token
  const tokenGroup = el('div', { className: 'field-group' });
  tokenGroup.appendChild(el('label', { htmlFor: 'setup-token' }, 'Setup Token'));
  const tokenInput = el('input', { id: 'setup-token', type: 'password', placeholder: 'Paste the token shown in your terminal', autocomplete: 'off', value: state.setupSessionToken });
  tokenInput.addEventListener('input', (e) => { state.setupSessionToken = e.target.value; });
  tokenGroup.appendChild(tokenInput);
  tokenGroup.appendChild(el('p', { className: 'field-hint' }, 'Enter the setup token displayed by the CLI. Lost it? Check ~/.local/state/openpalm/setup-token.txt'));
  content.appendChild(tokenGroup);

  // Owner name
  const nameGroup = el('div', { className: 'field-group' });
  nameGroup.appendChild(el('label', { htmlFor: 'owner-name' }, 'Your Name'));
  const nameInput = el('input', { id: 'owner-name', type: 'text', placeholder: 'Jane Doe', autocomplete: 'name', value: state.ownerName });
  nameInput.addEventListener('input', (e) => { state.ownerName = e.target.value; });
  nameGroup.appendChild(nameInput);
  nameGroup.appendChild(el('p', { className: 'field-hint' }, 'Used as the default Memory user ID.'));
  content.appendChild(nameGroup);

  // Owner email
  const emailGroup = el('div', { className: 'field-group' });
  emailGroup.appendChild(el('label', { htmlFor: 'owner-email' }, 'Email (optional)'));
  const emailInput = el('input', { id: 'owner-email', type: 'email', placeholder: 'jane@example.com', autocomplete: 'email', value: state.ownerEmail });
  emailInput.addEventListener('input', (e) => { state.ownerEmail = e.target.value; });
  emailGroup.appendChild(emailInput);
  emailGroup.appendChild(el('p', { className: 'field-hint' }, 'For account identification. Not shared externally.'));
  content.appendChild(emailGroup);

  // Admin token
  const adminGroup = el('div', { className: 'field-group' });
  adminGroup.appendChild(el('label', { htmlFor: 'admin-token' }, 'Admin Token'));
  const adminInput = el('input', { id: 'admin-token', type: 'password', placeholder: 'Enter a secure admin token (or leave for auto-generated)', autocomplete: 'new-password', value: state.adminToken });
  adminInput.addEventListener('input', (e) => { state.adminToken = e.target.value; });
  adminGroup.appendChild(adminInput);
  adminGroup.appendChild(el('p', { className: 'field-hint' }, 'This token protects your admin console. Leave blank to auto-generate a 32-char token.'));
  content.appendChild(adminGroup);

  // Error display
  content.appendChild(el('p', { id: 'welcome-error', className: 'field-error hidden', role: 'alert' }));

  // Actions
  const actions = el('div', { className: 'step-actions' });
  const startBtn = el('button', { className: 'btn btn-primary' }, COPY.welcomeStart);
  startBtn.addEventListener('click', () => {
    const errEl = $('#welcome-error');
    if (!state.setupSessionToken.trim()) { errEl.textContent = 'Setup token is required. Check your terminal output.'; errEl.classList.remove('hidden'); return; }
    if (!state.ownerName.trim()) { errEl.textContent = 'Name is required.'; errEl.classList.remove('hidden'); return; }
    // Auto-generate admin token if empty
    if (!state.adminToken.trim()) state.adminToken = generateAdminToken();
    if (state.adminToken.trim().length < 8) { errEl.textContent = 'Admin token must be at least 8 characters.'; errEl.classList.remove('hidden'); return; }
    errEl.classList.add('hidden');
    // Derive memoryUserId from name
    if (!state.memoryUserId || state.memoryUserId === 'default_user') {
      state.memoryUserId = state.ownerName.trim().toLowerCase().replace(/\s+/g, '_');
    }
    state.draftConnectionIndex = null;
    goToScreen('connections-hub');
  });
  actions.appendChild(startBtn);
  content.appendChild(actions);

  return content;
}

function renderConnectionsHubScreen() {
  const content = el('div', { className: 'step-content', dataset: { testid: 'step-connections-hub' } });
  content.appendChild(el('h2', null, COPY.connectionsHubTitle));
  content.appendChild(el('p', { className: 'step-description' }, COPY.connectionsHubBody));

  // Connection list or empty state
  if (state.connections.length === 0) {
    const empty = el('div', { className: 'hub-empty' });
    empty.appendChild(el('p', { className: 'hub-empty-headline' }, COPY.connectionsHubEmptyHeadline));
    empty.appendChild(el('p', { className: 'hub-empty-body' }, COPY.connectionsHubEmptyBody));
    const addBtn = el('button', { className: 'btn btn-primary' }, COPY.connectionsHubEmptyCta);
    addBtn.addEventListener('click', startNewConnection);
    empty.appendChild(addBtn);
    content.appendChild(empty);
  } else {
    const list = el('ul', { className: 'hub-list', 'aria-label': 'Connections' });
    state.connections.forEach((conn, i) => {
      const row = el('li', { className: 'hub-row' });
      const info = el('div', { className: 'hub-row-info' });
      info.appendChild(el('span', { className: 'hub-row-name' }, conn.name || conn.provider));
      info.appendChild(el('span', { className: 'hub-row-badge hub-row-type' }, conn.connectionType === 'local' ? 'Local' : 'Remote'));
      if (conn.tested) {
        const testedBadge = el('span', { className: 'hub-row-badge hub-row-tested', 'aria-label': 'Connection tested' });
        testedBadge.innerHTML = SVG_CHECK_10 + ' Tested';
        info.appendChild(testedBadge);
      }
      info.appendChild(el('span', { className: 'hub-row-url' }, conn.baseUrl || '(default URL)'));
      row.appendChild(info);

      const actions = el('div', { className: 'hub-row-actions' });
      const editBtn = el('button', { className: 'hub-action' }, 'Edit');
      editBtn.addEventListener('click', () => editConnection(i));
      actions.appendChild(editBtn);

      const dupBtn = el('button', { className: 'hub-action' }, 'Duplicate');
      dupBtn.addEventListener('click', () => duplicateConnection(i));
      actions.appendChild(dupBtn);

      const rmBtn = el('button', { className: 'hub-action hub-action--danger' }, 'Remove');
      rmBtn.addEventListener('click', () => removeConnection(i));
      actions.appendChild(rmBtn);

      row.appendChild(actions);
      list.appendChild(row);
    });
    content.appendChild(list);
  }

  const actions = el('div', { className: 'step-actions' });
  const backBtn = el('button', { className: 'btn btn-secondary' }, 'Back');
  backBtn.addEventListener('click', () => goToScreen('welcome'));
  actions.appendChild(backBtn);

  const addBtn = el('button', { className: 'btn btn-outline' }, COPY.connectionsHubAddBtn);
  addBtn.addEventListener('click', startNewConnection);
  actions.appendChild(addBtn);

  const nextBtn = el('button', { className: 'btn btn-primary', disabled: state.connections.length === 0 }, COPY.connectionsHubContinueBtn);
  nextBtn.addEventListener('click', () => goToScreen('models'));
  actions.appendChild(nextBtn);
  content.appendChild(actions);

  return content;
}

function renderConnectionTypeScreen() {
  const content = el('div', { className: 'step-content', dataset: { testid: 'step-connection-type' } });
  content.appendChild(el('h2', null, COPY.addConnectionTypeTitle));
  content.appendChild(el('p', { className: 'step-description' }, COPY.connectionTypePrompt));

  // Cloud card
  const cloudCard = el('button', { className: 'conn-card conn-card--cloud', type: 'button' });
  cloudCard.innerHTML = `
    <div class="conn-icon conn-icon--cloud" aria-hidden="true">${SVG_CLOUD}</div>
    <div class="conn-body">
      <span class="conn-label">Remote OpenAI-compatible <span class="conn-badge">Hosted</span></span>
      <span class="conn-desc">Best for OpenAI, Groq, Together, gateways, and work proxies. Usually requires an API key.</span>
      <span class="conn-note">Recommended if you already use a hosted API provider.</span>
    </div>
    <div class="conn-arrow" aria-hidden="true">${SVG_CHEVRON}</div>`;
  cloudCard.addEventListener('click', () => selectConnectionType('cloud'));
  content.appendChild(cloudCard);

  // Local card
  const localCard = el('button', { className: 'conn-card conn-card--local', type: 'button' });
  localCard.innerHTML = `
    <div class="conn-icon conn-icon--local" aria-hidden="true">${SVG_SERVER}</div>
    <div class="conn-body">
      <span class="conn-label">Local OpenAI-compatible <span class="conn-badge conn-badge--local">On-Device</span></span>
      <span class="conn-desc">Best for Ollama, LM Studio, and Docker Model Runner. We will try to detect what is running.</span>
      <span class="conn-note conn-note--recommended">Recommended for most self-hosted setups.</span>
    </div>
    <div class="conn-arrow" aria-hidden="true">${SVG_CHEVRON}</div>`;
  localCard.addEventListener('click', () => selectConnectionType('local'));
  content.appendChild(localCard);

  const actions = el('div', { className: 'step-actions' });
  const backBtn = el('button', { className: 'btn btn-secondary' }, 'Back');
  backBtn.addEventListener('click', () => {
    if (state.draftConnectionIndex !== null && state.draftConnectionIndex === state.connections.length - 1) {
      state.connections.pop();
      state.draftConnectionIndex = null;
    }
    goToScreen('connections-hub');
  });
  actions.appendChild(backBtn);
  content.appendChild(actions);

  return content;
}

function renderAddConnectionDetailsScreen() {
  const conn = state.connections[state.editingConnectionIndex];
  if (!conn) return el('div', null, 'No connection selected.');

  const content = el('div', { className: 'step-content', dataset: { testid: 'step-add-connection-details' } });
  content.appendChild(el('h2', null, COPY.addConnectionDetailsTitle));
  content.appendChild(el('p', { className: 'step-description' }, COPY.addConnectionDetailsBody));

  // Mode summary card
  const summary = getConnectionModeSummary(conn.connectionType);
  const modeCard = el('div', { className: `connection-mode-card connection-mode-card--${conn.connectionType}` });
  const modeHeader = el('div', { className: 'connection-mode-header' });
  modeHeader.appendChild(el('span', { className: 'connection-mode-badge' }, conn.connectionType === 'local' ? 'Local' : 'Remote'));
  modeHeader.appendChild(el('h3', null, summary.title));
  modeCard.appendChild(modeHeader);
  modeCard.appendChild(el('p', null, summary.body));
  const bulletList = el('ul', { className: 'connection-mode-list' });
  summary.bullets.forEach(b => bulletList.appendChild(el('li', null, b)));
  modeCard.appendChild(bulletList);
  content.appendChild(modeCard);

  // Connection name
  const nameGroup = el('div', { className: 'field-group' });
  nameGroup.appendChild(el('label', { htmlFor: 'conn-name' }, COPY.addConnectionNameLabel));
  const nameInput = el('input', { id: 'conn-name', type: 'text', value: conn.name, placeholder: COPY.addConnectionNamePlaceholder, autocomplete: 'organization' });
  nameInput.addEventListener('input', (e) => { conn.name = e.target.value; });
  nameGroup.appendChild(nameInput);
  content.appendChild(nameGroup);

  // Cloud: provider chips + API key
  if (conn.connectionType === 'cloud') {
    const chips = el('div', { className: 'provider-quick-picks' });
    for (const p of CLOUD_PROVIDERS) {
      const chip = el('button', { className: 'provider-chip' + (conn.provider === p ? ' selected' : ''), type: 'button' }, PROVIDER_LABELS[p] || p);
      chip.addEventListener('click', () => handleProviderChange(p));
      chips.appendChild(chip);
    }
    content.appendChild(chips);

    const apiKeyGroup = el('div', { className: 'field-group' });
    apiKeyGroup.appendChild(el('label', { htmlFor: 'conn-api-key' }, COPY.addConnectionApiKeyLabel));
    const apiKeyInput = el('input', { id: 'conn-api-key', type: 'password', value: conn.apiKey, placeholder: COPY.addConnectionApiKeyPlaceholder, autocomplete: 'new-password' });
    apiKeyInput.addEventListener('input', (e) => { conn.apiKey = e.target.value; scheduleAutoTest(); });
    apiKeyGroup.appendChild(apiKeyInput);
    apiKeyGroup.appendChild(el('p', { className: 'field-hint' }, COPY.addConnectionApiKeyHint));
    content.appendChild(apiKeyGroup);
  }

  // Local: detection + ollama enable
  if (conn.connectionType === 'local') {
    if (state.detectingProviders) {
      const loader = el('div', { className: 'loading-state', style: 'justify-content: flex-start; padding: 16px 0;' });
      loader.innerHTML = '<span class="spinner"></span><span style="font-size: var(--text-sm); color: var(--color-text-secondary); margin-left: 8px;">Detecting local providers...</span>';
      content.appendChild(loader);
    }

    if (state.providersDetected) {
      const availableProviders = state.detectedProviders.filter(p => p.available);
      for (const dp of availableProviders) {
        const opt = el('button', {
          className: 'provider-option' + (conn.provider === dp.provider ? ' selected' : ''),
          type: 'button',
        });
        opt.innerHTML = `
          <span class="provider-option-status"><span class="status-dot status-dot--ok"></span></span>
          <span class="provider-option-label">${PROVIDER_LABELS[dp.provider] || dp.provider}</span>
          <span class="provider-option-hint">Detected at ${dp.url}</span>`;
        opt.addEventListener('click', () => handleProviderChange(dp.provider));
        content.appendChild(opt);
      }

      // Ollama enable section
      const ollamaDetected = state.detectedProviders.some(p => p.provider === 'ollama' && p.available);
      if (!ollamaDetected && !state.ollamaEnabled) {
        const section = el('div', { className: 'enable-ollama-section' });
        const info = el('div', { className: 'enable-ollama-info' });
        info.appendChild(el('p', { className: 'enable-ollama-title' }, 'Ollama not detected'));
        info.appendChild(el('p', { className: 'enable-ollama-desc' }, `We can add Ollama to your stack and pull two small default models (${OLLAMA_DEFAULT_MODELS.chat} + ${OLLAMA_DEFAULT_MODELS.embedding}).`));
        section.appendChild(info);
        if (state.ollamaEnableError) {
          section.appendChild(el('p', { className: 'field-error', role: 'alert' }, state.ollamaEnableError));
        }
        if (state.enablingOllama) {
          const prog = el('div', { className: 'ollama-progress' });
          prog.innerHTML = `<span class="spinner"></span><span>${state.ollamaEnableProgress}</span>`;
          section.appendChild(prog);
        } else {
          const enableBtn = el('button', { className: 'btn btn-outline enable-ollama-btn', type: 'button' }, 'Enable Ollama');
          enableBtn.addEventListener('click', enableOllama);
          section.appendChild(enableBtn);
        }
        content.appendChild(section);
      }

      if (state.ollamaEnabled) {
        const success = el('div', { className: 'connection-success', role: 'status' });
        success.innerHTML = `${SVG_CHECK_CIRCLE} <span>Ollama enabled — default models pulled.</span>`;
        content.appendChild(success);
      }

      // Fallback provider select if nothing detected
      if (availableProviders.length === 0 && !state.ollamaEnabled) {
        const provGroup = el('div', { className: 'field-group' });
        provGroup.appendChild(el('label', { htmlFor: 'local-provider' }, 'Provider'));
        const provSel = el('select', { id: 'local-provider' });
        for (const p of LOCAL_PROVIDERS) {
          const o = el('option', { value: p }, PROVIDER_LABELS[p] || p);
          if (p === conn.provider) o.selected = true;
          provSel.appendChild(o);
        }
        provSel.addEventListener('change', (e) => handleProviderChange(e.target.value));
        provGroup.appendChild(provSel);
        content.appendChild(provGroup);
      }
    }
  }

  // Base URL
  const urlGroup = el('div', { className: 'field-group' });
  urlGroup.appendChild(el('label', { htmlFor: 'conn-base-url' }, COPY.addConnectionBaseUrlLabel));
  const urlPlaceholder = conn.connectionType === 'cloud' ? 'https://api.example.com' : 'http://localhost:1234';
  const urlInput = el('input', { id: 'conn-base-url', type: 'url', value: conn.baseUrl, placeholder: urlPlaceholder, autocomplete: 'url' });
  urlInput.addEventListener('input', (e) => { conn.baseUrl = e.target.value; });
  urlGroup.appendChild(urlInput);
  urlGroup.appendChild(el('p', { className: 'field-hint' }, COPY.addConnectionBaseUrlHint));
  if (/\/v1\/?$/.test((conn.baseUrl || '').trim())) {
    urlGroup.appendChild(el('p', { className: 'field-warn' }, COPY.addConnectionBaseUrlWarn));
  }
  content.appendChild(urlGroup);

  // Connection error
  content.appendChild(el('p', { id: 'conn-error', className: 'field-error hidden', role: 'alert' }));

  // Connection success
  if (conn.tested) {
    const success = el('div', { className: 'connection-success', role: 'status' });
    success.innerHTML = `${SVG_CHECK_CIRCLE} <span>Connected — ${conn.modelList.length} model${conn.modelList.length !== 1 ? 's' : ''} found.</span>`;
    content.appendChild(success);
  }

  // Actions
  const actions = el('div', { className: 'step-actions' });
  const cancelBtn = el('button', { className: 'btn btn-secondary' }, COPY.addConnectionCancelBtn);
  cancelBtn.addEventListener('click', () => goToScreen('connection-type'));
  actions.appendChild(cancelBtn);

  if (!state.ollamaEnabled || conn.connectionType === 'cloud') {
    const testBtn = el('button', { className: 'btn btn-outline' }, 'Test Connection');
    testBtn.addEventListener('click', () => testConnection());
    actions.appendChild(testBtn);
  }

  const saveBtn = el('button', { className: 'btn btn-primary' }, COPY.addConnectionSaveBtn);
  saveBtn.addEventListener('click', () => {
    const errEl = $('#conn-error');
    if (!conn.name.trim()) { errEl.textContent = 'Connection name is required.'; errEl.classList.remove('hidden'); return; }
    const err = validateConnectionFields();
    if (err) { errEl.textContent = err; errEl.classList.remove('hidden'); return; }
    errEl.classList.add('hidden');
    finalizeConnection();
  });
  actions.appendChild(saveBtn);
  content.appendChild(actions);

  return content;
}

function renderModelsScreen() {
  const content = el('div', { className: 'step-content', dataset: { testid: 'step-models' } });
  content.appendChild(el('h2', null, COPY.selectModelsTitle));
  content.appendChild(el('p', { className: 'step-description' }, COPY.selectModelsDescription));

  const a = state.assignments;
  const llmConn = getConnectionById(a.llm.connectionId);
  const embConn = getConnectionById(a.embeddings.connectionId);
  const llmModels = llmConn ? llmConn.modelList : [];
  const embModels = embConn ? getEmbeddingModelOptions(embConn, embConn.modelList, a.embeddings.model) : [];

  // LLM Card
  const llmCard = el('div', { className: 'model-card' });
  const llmHeader = el('div', { className: 'model-card-header' });
  llmHeader.appendChild(el('span', { className: 'model-card-title' }, COPY.llmCardTitle));
  llmHeader.appendChild(el('span', { className: 'model-card-help' }, COPY.llmCardHelp));
  llmCard.appendChild(llmHeader);

  // LLM connection
  const llmConnGroup = el('div', { className: 'field-group' });
  llmConnGroup.appendChild(el('label', { htmlFor: 'llm-connection' }, COPY.llmConnectionLabel));
  llmConnGroup.appendChild(renderConnectionSelect('llm-connection', a.llm.connectionId, COPY.llmConnectionPlaceholder, (val) => {
    a.llm.connectionId = val;
    const nextConn = getConnectionById(val);
    if (nextConn && nextConn.modelList.length > 0) {
      a.llm.model = nextConn.modelList[0];
      a.llm.smallModel = nextConn.modelList.includes(a.llm.smallModel) ? a.llm.smallModel : nextConn.modelList[0];
    }
    render();
  }));
  llmCard.appendChild(llmConnGroup);

  // Chat model
  const chatGroup = el('div', { className: 'field-group' });
  chatGroup.appendChild(el('label', { htmlFor: 'system-model' }, 'Chat model'));
  chatGroup.appendChild(renderModelSelector('system-model', a.llm.model, llmModels, 'gpt-4o-mini', (v) => { a.llm.model = v; }));
  llmCard.appendChild(chatGroup);

  // Small model
  const smallGroup = el('div', { className: 'field-group' });
  smallGroup.appendChild(el('label', { htmlFor: 'small-model' }, COPY.llmSmallModelLabel));
  smallGroup.appendChild(renderModelSelector('small-model', a.llm.smallModel, llmModels, COPY.llmSmallModelPlaceholder, (v) => { a.llm.smallModel = v; }));
  smallGroup.appendChild(el('p', { className: 'field-hint' }, COPY.llmSmallModelHint));
  llmCard.appendChild(smallGroup);
  content.appendChild(llmCard);

  // Embeddings Card
  const embCard = el('div', { className: 'model-card' });
  const embHeader = el('div', { className: 'model-card-header' });
  embHeader.appendChild(el('span', { className: 'model-card-title' }, COPY.embeddingsCardTitle));
  embHeader.appendChild(el('span', { className: 'model-card-help' }, COPY.embeddingsCardHelp));
  embCard.appendChild(embHeader);

  // Embedding connection
  const embConnGroup = el('div', { className: 'field-group' });
  embConnGroup.appendChild(el('label', { htmlFor: 'emb-connection' }, 'Connection'));
  embConnGroup.appendChild(renderConnectionSelect('emb-connection', a.embeddings.connectionId, COPY.embeddingConnectionPlaceholder, (val) => {
    a.embeddings.connectionId = val;
    a.embeddings.sameAsLlm = false;
    const nextConn = getConnectionById(val);
    if (nextConn) {
      const nextModel = pickPreferredEmbeddingModel(nextConn, nextConn.modelList);
      a.embeddings.model = nextModel.model || a.embeddings.model;
      a.embeddings.embeddingDims = nextModel.dims || a.embeddings.embeddingDims;
    }
    render();
  }));
  embCard.appendChild(embConnGroup);

  // Embedding model
  const embModelGroup = el('div', { className: 'field-group' });
  embModelGroup.appendChild(el('label', { htmlFor: 'embedding-model' }, 'Embedding model'));
  embModelGroup.appendChild(renderModelSelector('embedding-model', a.embeddings.model, embModels, 'text-embedding-3-small', (v) => {
    a.embeddings.model = v;
    if (embConn) {
      const dims = resolveEmbeddingDims(embConn.provider, v);
      if (dims) a.embeddings.embeddingDims = dims;
    }
    render();
  }));
  embModelGroup.appendChild(el('p', { className: 'field-hint' }, 'Used for memory vector embeddings. The list prefers embedding-capable models.'));

  // Dims hint
  let dimsHint = 'Choose an embedding model to auto-fill dimensions when possible.';
  if (a.embeddings.model.trim() && embConn) {
    const detected = resolveEmbeddingDims(embConn.provider, a.embeddings.model);
    if (detected !== null) {
      dimsHint = `Dimensions auto-detected for this model: ${detected}.`;
    } else {
      dimsHint = `Dimensions are using the current value (${a.embeddings.embeddingDims}) because this model is not in the known embedding map yet.`;
    }
  }
  embModelGroup.appendChild(el('p', { className: 'field-hint field-hint--accent' }, dimsHint));
  embCard.appendChild(embModelGroup);

  // Embedding dims
  const dimsGroup = el('div', { className: 'field-group field-group--compact' });
  dimsGroup.appendChild(el('label', { htmlFor: 'embedding-dims' }, COPY.embeddingsDimsLabel));
  const dimsInput = el('input', { id: 'embedding-dims', type: 'number', value: String(a.embeddings.embeddingDims), placeholder: COPY.embeddingsDimsPlaceholder, min: '1', step: '1' });
  dimsInput.addEventListener('input', (e) => { a.embeddings.embeddingDims = parseInt(e.target.value, 10) || 1536; });
  dimsGroup.appendChild(dimsInput);
  dimsGroup.appendChild(el('p', { className: 'field-hint' }, COPY.embeddingsDimsHint));
  embCard.appendChild(dimsGroup);
  content.appendChild(embCard);

  // Add connection link
  const addLink = el('button', { className: 'add-connection-link', type: 'button' }, COPY.addAnotherConnection);
  addLink.addEventListener('click', startNewConnection);
  content.appendChild(addLink);

  // Error
  content.appendChild(el('p', { id: 'models-error', className: 'field-error hidden', role: 'alert' }));

  // Actions
  const actions = el('div', { className: 'step-actions' });
  const backBtn = el('button', { className: 'btn btn-secondary' }, 'Back');
  backBtn.addEventListener('click', () => goToScreen('connections-hub'));
  actions.appendChild(backBtn);

  const nextBtn = el('button', { className: 'btn btn-primary' }, 'Continue');
  nextBtn.addEventListener('click', () => {
    const errEl = $('#models-error');
    if (!a.llm.connectionId.trim()) { errEl.textContent = 'Select a chat connection before continuing.'; errEl.classList.remove('hidden'); return; }
    if (!a.embeddings.connectionId.trim()) { errEl.textContent = 'Select an embedding connection before continuing.'; errEl.classList.remove('hidden'); return; }
    if (!a.llm.model.trim()) { errEl.textContent = 'Chat model is required.'; errEl.classList.remove('hidden'); return; }
    if (!a.embeddings.model.trim()) { errEl.textContent = 'Embedding model is required.'; errEl.classList.remove('hidden'); return; }
    errEl.classList.add('hidden');
    goToScreen('optional-addons');
  });
  actions.appendChild(nextBtn);
  content.appendChild(actions);

  return content;
}

function renderOptionalAddonsScreen() {
  const content = el('div', { className: 'step-content', dataset: { testid: 'step-optional-addons' } });
  content.appendChild(el('h2', null, COPY.optionalAddonsTitle));
  content.appendChild(el('p', { className: 'step-description' }, COPY.optionalAddonsBody));

  const a = state.assignments;

  // Reranking
  content.appendChild(renderAddonRow('reranking', a.reranking, COPY.rerankingToggleLabel, COPY.rerankingToggleHelp, (fields) => {
    // Reranking type radio
    const typeFieldset = el('fieldset', { className: 'radio-fieldset' });
    typeFieldset.appendChild(el('legend', { className: 'radio-legend' }, COPY.rerankingTypeLabel));
    const radioGroup = el('div', { className: 'radio-group' });
    const llmRadio = el('label', { className: 'radio-label' });
    const llmInput = el('input', { type: 'radio', name: 'reranking-type', value: 'llm', checked: a.reranking.mode === 'llm' });
    llmInput.addEventListener('change', () => { a.reranking.mode = 'llm'; render(); });
    llmRadio.appendChild(llmInput);
    llmRadio.appendChild(document.createTextNode(' ' + COPY.rerankingTypeLlm));
    radioGroup.appendChild(llmRadio);
    const dedRadio = el('label', { className: 'radio-label' });
    const dedInput = el('input', { type: 'radio', name: 'reranking-type', value: 'dedicated', checked: a.reranking.mode === 'dedicated' });
    dedInput.addEventListener('change', () => { a.reranking.mode = 'dedicated'; render(); });
    dedRadio.appendChild(dedInput);
    dedRadio.appendChild(document.createTextNode(' ' + COPY.rerankingTypeDedicated));
    radioGroup.appendChild(dedRadio);
    typeFieldset.appendChild(radioGroup);
    fields.appendChild(el('div', { className: 'field-group' }, typeFieldset));

    // Connection
    const connGroup = el('div', { className: 'field-group' });
    connGroup.appendChild(el('label', { htmlFor: 'reranking-connection' }, 'Connection'));
    connGroup.appendChild(renderConnectionSelect('reranking-connection', a.reranking.connectionId, '-- select connection --', (v) => { a.reranking.connectionId = v; render(); }));
    fields.appendChild(connGroup);

    // Model
    const modelGroup = el('div', { className: 'field-group' });
    modelGroup.appendChild(el('label', { htmlFor: 'reranking-model' }, 'Model'));
    const rerankConn = getConnectionById(a.reranking.connectionId);
    modelGroup.appendChild(renderModelSelector('reranking-model', a.reranking.model, rerankConn ? rerankConn.modelList : [], 'e.g., rerank-2', (v) => { a.reranking.model = v; }));
    fields.appendChild(modelGroup);

    // Top N
    const topNGroup = el('div', { className: 'field-group' });
    topNGroup.appendChild(el('label', { htmlFor: 'reranking-topn' }, 'Top N results'));
    const topNInput = el('input', { id: 'reranking-topn', type: 'number', value: String(a.reranking.topN), min: '1', step: '1' });
    topNInput.addEventListener('input', (e) => { a.reranking.topN = parseInt(e.target.value, 10) || 5; });
    topNGroup.appendChild(topNInput);
    fields.appendChild(topNGroup);
  }));

  // TTS
  content.appendChild(renderAddonRow('tts', a.tts, COPY.ttsToggleLabel, COPY.ttsToggleHelp, (fields) => {
    // Connection
    const connGroup = el('div', { className: 'field-group' });
    connGroup.appendChild(el('label', { htmlFor: 'tts-connection' }, 'Connection'));
    connGroup.appendChild(renderConnectionSelect('tts-connection', a.tts.connectionId, '-- select connection --', (v) => { a.tts.connectionId = v; render(); }));
    fields.appendChild(connGroup);

    // Model
    const modelGroup = el('div', { className: 'field-group' });
    modelGroup.appendChild(el('label', { htmlFor: 'tts-model' }, 'Model (optional)'));
    const ttsConn = getConnectionById(a.tts.connectionId);
    modelGroup.appendChild(renderModelSelector('tts-model', a.tts.model, ttsConn ? ttsConn.modelList : [], 'e.g., tts-1', (v) => { a.tts.model = v; }));
    fields.appendChild(modelGroup);

    // Voice
    const voiceGroup = el('div', { className: 'field-group' });
    voiceGroup.appendChild(el('label', { htmlFor: 'tts-voice' }, 'Voice (optional)'));
    const voiceInput = el('input', { id: 'tts-voice', type: 'text', value: a.tts.voice, placeholder: 'e.g., alloy' });
    voiceInput.addEventListener('input', (e) => { a.tts.voice = e.target.value; });
    voiceGroup.appendChild(voiceInput);
    fields.appendChild(voiceGroup);

    // Format
    const fmtGroup = el('div', { className: 'field-group' });
    fmtGroup.appendChild(el('label', { htmlFor: 'tts-format' }, 'Output format (optional)'));
    const fmtInput = el('input', { id: 'tts-format', type: 'text', value: a.tts.format, placeholder: 'e.g., mp3' });
    fmtInput.addEventListener('input', (e) => { a.tts.format = e.target.value; });
    fmtGroup.appendChild(fmtInput);
    fields.appendChild(fmtGroup);
  }));

  // STT
  content.appendChild(renderAddonRow('stt', a.stt, COPY.sttToggleLabel, COPY.sttToggleHelp, (fields) => {
    // Connection
    const connGroup = el('div', { className: 'field-group' });
    connGroup.appendChild(el('label', { htmlFor: 'stt-connection' }, 'Connection'));
    connGroup.appendChild(renderConnectionSelect('stt-connection', a.stt.connectionId, '-- select connection --', (v) => { a.stt.connectionId = v; render(); }));
    fields.appendChild(connGroup);

    // Model
    const modelGroup = el('div', { className: 'field-group' });
    modelGroup.appendChild(el('label', { htmlFor: 'stt-model' }, 'Model (optional)'));
    const sttConn = getConnectionById(a.stt.connectionId);
    modelGroup.appendChild(renderModelSelector('stt-model', a.stt.model, sttConn ? sttConn.modelList : [], 'e.g., whisper-1', (v) => { a.stt.model = v; }));
    fields.appendChild(modelGroup);

    // Language
    const langGroup = el('div', { className: 'field-group' });
    langGroup.appendChild(el('label', { htmlFor: 'stt-language' }, 'Language (optional)'));
    const langInput = el('input', { id: 'stt-language', type: 'text', value: a.stt.language, placeholder: 'e.g., en' });
    langInput.addEventListener('input', (e) => { a.stt.language = e.target.value; });
    langGroup.appendChild(langInput);
    fields.appendChild(langGroup);
  }));

  // Actions
  const actions = el('div', { className: 'step-actions' });
  const backBtn = el('button', { className: 'btn btn-secondary' }, 'Back');
  backBtn.addEventListener('click', () => goToScreen('models'));
  actions.appendChild(backBtn);
  const nextBtn = el('button', { className: 'btn btn-primary' }, 'Continue');
  nextBtn.addEventListener('click', () => goToScreen('review'));
  actions.appendChild(nextBtn);
  content.appendChild(actions);

  return content;
}

function renderAddonRow(key, addonState, label, help, renderFields) {
  const row = el('div', { className: 'addon-row' + (addonState.enabled ? ' addon-row--active' : '') });
  const toggleRow = el('div', { className: 'addon-toggle-row' });
  const toggleLabel = el('label', { className: 'addon-toggle-label' });
  const checkbox = el('input', { type: 'checkbox', checked: addonState.enabled });
  checkbox.addEventListener('change', (e) => { addonState.enabled = e.target.checked; render(); });
  toggleLabel.appendChild(checkbox);
  toggleLabel.appendChild(el('span', { className: 'addon-label-text' }, label));
  toggleRow.appendChild(toggleLabel);
  toggleRow.appendChild(el('span', { className: 'addon-help' }, help));
  row.appendChild(toggleRow);

  if (addonState.enabled) {
    const fields = el('div', { className: 'addon-fields' });
    renderFields(fields);
    row.appendChild(fields);
  }

  return row;
}

function renderReviewScreen() {
  const content = el('div', { className: 'step-content', dataset: { testid: 'step-review' } });
  content.appendChild(el('h2', null, COPY.reviewTitle));
  content.appendChild(el('p', { className: 'step-description' }, COPY.reviewBody));

  const a = state.assignments;

  // Account section
  const grid1 = el('div', { className: 'review-grid' });
  const accHeader = el('div', { className: 'review-section-header' });
  accHeader.appendChild(el('span', null, 'Account'));
  const accEditBtn = el('button', { className: 'review-edit-btn', type: 'button' }, 'Edit');
  accEditBtn.addEventListener('click', () => goToScreen('welcome'));
  accHeader.appendChild(accEditBtn);
  grid1.appendChild(accHeader);
  grid1.appendChild(reviewItem('Name', state.ownerName || '(not set)'));
  if (state.ownerEmail) grid1.appendChild(reviewItem('Email', state.ownerEmail));
  grid1.appendChild(reviewItem('Admin Token', 'Set', true));

  // Connections section
  const connHeader = el('div', { className: 'review-section-header' });
  connHeader.appendChild(el('span', null, COPY.reviewSectionConnections));
  const connEditBtn = el('button', { className: 'review-edit-btn', type: 'button' }, 'Edit');
  connEditBtn.addEventListener('click', () => goToScreen('connections-hub'));
  connHeader.appendChild(connEditBtn);
  grid1.appendChild(connHeader);
  state.connections.forEach((conn, i) => {
    const label = state.connections.length > 1 ? `Provider ${i + 1}` : 'Provider';
    grid1.appendChild(reviewItem(label, `${conn.connectionType === 'local' ? 'Local' : 'Cloud'} — ${conn.name || PROVIDER_LABELS[conn.provider] || conn.provider}`));
    if (conn.apiKey) grid1.appendChild(reviewItem(state.connections.length > 1 ? `API Key (${conn.name})` : 'API Key', maskedKey(conn.apiKey), true));
    if (conn.baseUrl) grid1.appendChild(reviewItem(state.connections.length > 1 ? `Base URL (${conn.name})` : 'Base URL', conn.baseUrl, true));
  });
  if (state.ollamaEnabled) grid1.appendChild(reviewItem('Ollama', 'Enabled (in-stack)'));

  // Models section
  const modelsHeader = el('div', { className: 'review-section-header' });
  modelsHeader.appendChild(el('span', null, COPY.reviewSectionModels));
  const modelsEditBtn = el('button', { className: 'review-edit-btn', type: 'button' }, 'Edit');
  modelsEditBtn.addEventListener('click', () => goToScreen('models'));
  modelsHeader.appendChild(modelsEditBtn);
  grid1.appendChild(modelsHeader);
  grid1.appendChild(reviewItem('Chat Model', formatModelReview(a.llm.model, a.llm.connectionId), true));
  if (a.llm.smallModel) grid1.appendChild(reviewItem('Small Model', formatModelReview(a.llm.smallModel, a.llm.connectionId), true));
  grid1.appendChild(reviewItem('Embedding Model', formatModelReview(a.embeddings.model, a.embeddings.connectionId), true));
  grid1.appendChild(reviewItem('Memory Model', formatModelReview(getEffectiveMemoryModel(), a.llm.connectionId), true));
  grid1.appendChild(reviewItem('Embedding Dimensions', String(a.embeddings.embeddingDims), true));
  grid1.appendChild(reviewItem('Memory User ID', state.memoryUserId));

  // Addons section
  const addonsHeader = el('div', { className: 'review-section-header' });
  addonsHeader.appendChild(el('span', null, COPY.reviewSectionAddons));
  const addonsEditBtn = el('button', { className: 'review-edit-btn', type: 'button' }, 'Edit');
  addonsEditBtn.addEventListener('click', () => goToScreen('optional-addons'));
  addonsHeader.appendChild(addonsEditBtn);
  grid1.appendChild(addonsHeader);

  if (a.reranking.enabled || a.tts.enabled || a.stt.enabled) {
    if (a.reranking.enabled) {
      grid1.appendChild(reviewItem('Reranking', formatAddonReview(true, a.reranking.connectionId, [a.reranking.mode === 'llm' ? 'LLM reranker' : 'Dedicated reranker', a.reranking.model])));
    }
    if (a.tts.enabled) {
      grid1.appendChild(reviewItem('Text-to-Speech', formatAddonReview(true, a.tts.connectionId, [a.tts.model || 'Enabled', a.tts.voice])));
    }
    if (a.stt.enabled) {
      grid1.appendChild(reviewItem('Speech-to-Text', formatAddonReview(true, a.stt.connectionId, [a.stt.model || 'Enabled', a.stt.language])));
    }
  } else {
    const noneItem = el('div', { className: 'review-item' });
    noneItem.appendChild(el('span', { className: 'review-label review-label--muted' }, 'None configured'));
    noneItem.appendChild(el('span', { className: 'review-value' }));
    grid1.appendChild(noneItem);
  }

  content.appendChild(grid1);

  // Install error
  if (state.installError) {
    content.appendChild(el('p', { className: 'install-error', role: 'alert' }, state.installError));
  }

  // Actions
  const actions = el('div', { className: 'step-actions' });
  const backBtn = el('button', { className: 'btn btn-secondary', disabled: state.installing }, 'Back');
  backBtn.addEventListener('click', () => goToScreen('optional-addons'));
  actions.appendChild(backBtn);

  const installBtn = el('button', { className: 'btn btn-primary', disabled: state.installing });
  if (state.installing) {
    installBtn.innerHTML = '<span class="spinner"></span> Installing...';
  } else {
    installBtn.textContent = COPY.reviewSaveBtn;
  }
  installBtn.addEventListener('click', handleInstall);
  actions.appendChild(installBtn);
  content.appendChild(actions);

  return content;
}

function reviewItem(label, value, mono) {
  const item = el('div', { className: 'review-item' });
  item.appendChild(el('span', { className: 'review-label' }, label));
  item.appendChild(el('span', { className: 'review-value' + (mono ? ' mono' : '') }, value));
  return item;
}

function renderDeployingScreen() {
  const content = el('div', { className: 'step-content', dataset: { testid: 'step-deploying' } });

  // Header
  const header = el('div', { className: 'deploy-header' });
  header.appendChild(el('h2', null, 'Setting Up Your Stack'));
  let phaseText = 'Preparing deployment...';
  if (state.deployPhase === 'pulling') phaseText = 'Pulling container images...';
  else if (state.deployPhase === 'starting') phaseText = 'Starting services...';
  else if (state.deployPhase === 'ready') phaseText = 'All services are up and running.';
  else if (state.deployPhase === 'error') phaseText = 'OpenPalm could not finish starting.';
  header.appendChild(el('p', { className: 'step-description' }, phaseText));
  content.appendChild(header);

  // Progress bar
  const progress = getDeployProgress(state.deployServices);
  const progressSection = el('div', { className: 'deploy-progress-summary' });
  const meta = el('div', { className: 'deploy-progress-meta' });
  meta.appendChild(el('span', { className: 'deploy-progress-label' }, state.deployPhase === 'error' ? 'Startup stopped' : 'Overall progress'));
  const valueClass = 'deploy-progress-value' + (state.deployPhase === 'error' ? ' deploy-progress-value--error' : '');
  meta.appendChild(el('span', { className: valueClass }, state.deployPhase === 'error' ? 'Needs attention' : `${progress}%`));
  progressSection.appendChild(meta);

  const barClass = 'deploy-progress-bar' + (state.deployPhase === 'error' ? ' deploy-progress-bar--error' : '');
  const bar = el('div', { className: barClass });
  const fillClass = 'deploy-progress-fill' + (state.deployPhase === 'error' ? ' deploy-progress-fill--error' : '');
  bar.appendChild(el('div', { className: fillClass, style: `width: ${progress}%` }));
  progressSection.appendChild(bar);
  if (state.deployMessage && state.deployPhase !== 'error') {
    progressSection.appendChild(el('p', { className: 'deploy-progress-note' }, state.deployMessage));
  }
  content.appendChild(progressSection);

  // Error card
  if (state.deployPhase === 'error') {
    const failCard = el('section', { className: 'deploy-failure-card', role: 'alert', 'aria-label': 'Deployment failure summary' });
    const failHeader = el('div', { className: 'deploy-failure-header' });
    failHeader.appendChild(el('span', { className: 'deploy-failure-kicker' }, 'Setup needs attention'));
    failHeader.appendChild(el('h3', null, 'OpenPalm could not finish starting the stack'));
    failCard.appendChild(failHeader);
    failCard.appendChild(el('p', { className: 'deploy-failure-summary' }, summarizeDeployError(state.deployError)));
    const recList = el('ul', { className: 'deploy-failure-list' });
    recList.appendChild(el('li', null, 'Go back to Review to adjust settings, then try again.'));
    recList.appendChild(el('li', null, 'Open Technical details if you need the raw Docker error for troubleshooting.'));
    failCard.appendChild(recList);
    content.appendChild(failCard);
  }

  // Service rows
  const services = el('div', { className: 'deploy-services' });
  for (const svc of state.deployServices) {
    const row = el('div', { className: 'deploy-service-row' });
    const indicator = el('div', { className: 'deploy-service-indicator' });

    if (state.deployPhase === 'error' && svc.imageReady && !svc.containerRunning) {
      indicator.innerHTML = `<span class="deploy-warning">${SVG_WARNING}</span>`;
    } else if (svc.containerRunning || svc.imageReady) {
      indicator.innerHTML = `<span class="deploy-check">${SVG_CHECK_18}</span>`;
    } else {
      indicator.innerHTML = '<span class="deploy-spinner"><span class="spinner"></span></span>';
    }
    row.appendChild(indicator);

    const info = el('div', { className: 'deploy-service-info' });
    info.appendChild(el('span', { className: 'deploy-service-name' }, svc.label));
    info.appendChild(el('span', { className: 'deploy-service-status' }, getDeployStatusText(svc)));
    row.appendChild(info);

    const barContainer = el('div', { className: 'deploy-service-bar' });
    let barFillClass = 'deploy-bar-fill';
    if (svc.containerRunning) barFillClass += ' complete';
    else if (svc.imageReady && state.deployPhase !== 'error') barFillClass += ' ready';
    else if (svc.imageReady && state.deployPhase === 'error') barFillClass += ' stopped';
    else barFillClass += ' indeterminate';
    barContainer.appendChild(el('div', { className: barFillClass }));
    row.appendChild(barContainer);

    services.appendChild(row);
  }
  content.appendChild(services);

  // Tips
  if (state.deployPhase !== 'error') {
    const tips = el('aside', { className: 'deploy-tips', 'aria-label': 'Startup tips' });
    const tipsHeader = el('div', { className: 'deploy-tips-header' });
    tipsHeader.appendChild(el('span', { className: 'deploy-tips-kicker' }, 'Tips while you wait'));
    tipsHeader.appendChild(el('h3', null, 'What is happening right now?'));
    tips.appendChild(tipsHeader);
    const tipList = el('ul');
    for (const tip of getDeployTipList()) tipList.appendChild(el('li', null, tip));
    tips.appendChild(tipList);
    content.appendChild(tips);
  }

  // Error details + actions
  if (state.deployPhase === 'error') {
    const details = el('details', { className: 'deploy-error-details' });
    details.appendChild(el('summary', null, 'Technical details'));
    details.appendChild(el('pre', null, state.deployError));
    content.appendChild(details);

    const actions = el('div', { className: 'step-actions' });
    const backBtn = el('button', { className: 'btn btn-secondary' }, 'Back to Review');
    backBtn.addEventListener('click', () => { resetDeployUiState(); goToScreen('review'); });
    actions.appendChild(backBtn);
    const retryBtn = el('button', { className: 'btn btn-primary' }, 'Try Again');
    retryBtn.addEventListener('click', () => { resetDeployUiState(); handleInstall(); });
    actions.appendChild(retryBtn);
    content.appendChild(actions);
  }

  // Done
  if (state.deployPhase === 'ready') {
    const done = el('div', { className: 'deploy-done' });
    const link = el('a', { href: '/', className: 'btn btn-primary' }, 'Go to Console');
    done.appendChild(link);
    content.appendChild(done);
  }

  return content;
}

/* =========================================================================
   Main Render
   ========================================================================= */

function render() {
  const root = $('#wizard-root');
  if (!root) return;

  // Clear
  root.innerHTML = '';

  const page = el('main', { className: 'setup-page', 'aria-label': 'Setup wizard' });
  const card = el('div', { className: 'wizard-card' });

  // Header
  const header = el('div', { className: 'wizard-header' });
  header.appendChild(el('h1', null, COPY.wizardHeaderTitle));
  header.appendChild(el('p', { className: 'wizard-subtitle' }, COPY.wizardHeaderSubtitle));
  card.appendChild(header);

  const body = el('div', { className: 'wizard-body' });

  // Step indicators (not on deploying screen)
  if (state.screen !== 'deploying') {
    body.appendChild(renderStepIndicators());
  }

  // Render current screen
  switch (state.screen) {
    case 'welcome':
      body.appendChild(renderWelcomeScreen());
      break;
    case 'connections-hub':
      body.appendChild(renderConnectionsHubScreen());
      break;
    case 'connection-type':
      body.appendChild(renderConnectionTypeScreen());
      break;
    case 'add-connection-details':
      body.appendChild(renderAddConnectionDetailsScreen());
      break;
    case 'models':
      body.appendChild(renderModelsScreen());
      break;
    case 'optional-addons':
      body.appendChild(renderOptionalAddonsScreen());
      break;
    case 'review':
    case 'install':
      body.appendChild(renderReviewScreen());
      break;
    case 'deploying':
      body.appendChild(renderDeployingScreen());
      break;
  }

  card.appendChild(body);
  page.appendChild(card);
  root.appendChild(page);
}

/* =========================================================================
   Init
   ========================================================================= */

document.addEventListener('DOMContentLoaded', () => {
  // Check URL for initial screen
  const params = new URL(window.location.href).searchParams;
  const screenParam = params.get('screen');
  if (screenParam && SCREEN_ORDER.includes(screenParam)) {
    // Only allow screens that don't need state
    const safeScreens = ['welcome', 'connections-hub'];
    if (safeScreens.includes(screenParam) || state.connections.length > 0) {
      state.screen = screenParam;
      state.furthestScreen = maxScreen(state.furthestScreen, screenParam);
    }
  }

  // Pre-generate admin token
  if (!state.adminToken) {
    state.adminToken = generateAdminToken();
  }

  render();
});
