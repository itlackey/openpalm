import type { Provider, ProviderGroup, Portal, OpenCodeProvider } from './types.js';
import { OLLAMA_DEFAULT_CHAT_MODEL } from '@openpalm/lib/provider-constants';

export { OLLAMA_DEFAULT_CHAT_MODEL };

export const PROVIDER_GROUPS: ProviderGroup[] = [
  { id: 'recommended', label: 'Recommended', desc: 'Best options to get started quickly' },
  { id: 'local', label: 'Local', desc: 'Run models on your own hardware' },
  { id: 'cloud', label: 'Cloud', desc: 'Hosted inference providers' },
  { id: 'advanced', label: 'Advanced', desc: 'Additional providers' },
];

export const PROVIDERS: Provider[] = [
  { id: 'ollama', name: 'Ollama', kind: 'local', group: 'recommended', order: 1, icon: '🦙', desc: 'Run open models on your hardware', needsKey: false, placeholder: '', baseUrl: 'http://localhost:11434', llmModel: 'llama3.2', embModel: 'nomic-embed-text', embDims: 768, canDetect: true },
  { id: 'huggingface', name: 'Hugging Face', kind: 'cloud', group: 'recommended', order: 2, icon: '🤗', desc: '10,000+ open models via Inference Providers', needsKey: true, placeholder: 'hf_...', baseUrl: 'https://router.huggingface.co/v1', llmModel: 'Qwen/Qwen3-32B', embModel: 'intfloat/multilingual-e5-large', embDims: 1024, keyPrefix: 'hf_' },
  { id: 'openai', name: 'OpenAI', kind: 'cloud', group: 'recommended', order: 3, icon: '◐', desc: 'GPT and o-series reasoning models', needsKey: true, placeholder: 'sk-...', baseUrl: 'https://api.openai.com', llmModel: 'gpt-4o', embModel: 'text-embedding-3-small', embDims: 1536 },
  { id: 'google', name: 'Google', kind: 'cloud', group: 'recommended', order: 4, icon: '◆', desc: 'Gemini models with large context', needsKey: true, placeholder: 'AIza...', baseUrl: 'https://generativelanguage.googleapis.com', llmModel: 'gemini-2.5-flash', embModel: '', embDims: 0, keyPrefix: 'AI' },
  { id: 'model-runner', name: 'Docker Model Runner', kind: 'local', group: 'local', order: 1, icon: '🐳', desc: 'Docker-managed model runtime', needsKey: false, placeholder: '', baseUrl: 'http://localhost:12434', llmModel: 'ai/llama3.2', embModel: 'ai/mxbai-embed-large-v1', embDims: 1024, canDetect: true },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', group: 'local', order: 2, icon: '🔬', desc: 'Desktop app for local inference', needsKey: false, placeholder: '', baseUrl: 'http://localhost:1234', llmModel: 'loaded-model', embModel: '', embDims: 0, canDetect: true },
  { id: 'groq', name: 'Groq', kind: 'cloud', group: 'cloud', order: 1, icon: '⚡', desc: 'Ultra-fast inference', needsKey: true, placeholder: 'gsk_...', baseUrl: 'https://api.groq.com/openai', llmModel: 'llama-3.3-70b-versatile', embModel: '', embDims: 0 },
  { id: 'mistral', name: 'Mistral', kind: 'cloud', group: 'cloud', order: 2, icon: '◆', desc: 'Mistral & Codestral models', needsKey: true, placeholder: '...', baseUrl: 'https://api.mistral.ai', llmModel: 'mistral-large-latest', embModel: 'mistral-embed', embDims: 1024 },
  { id: 'together', name: 'Together AI', kind: 'cloud', group: 'cloud', order: 3, icon: '✦', desc: 'Open models at scale', needsKey: true, placeholder: '...', baseUrl: 'https://api.together.xyz', llmModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', embModel: '', embDims: 0 },
  { id: 'deepseek', name: 'DeepSeek', kind: 'cloud', group: 'advanced', order: 1, icon: '◎', desc: 'DeepSeek chat & reasoning', needsKey: true, placeholder: 'sk-...', baseUrl: 'https://api.deepseek.com', llmModel: 'deepseek-chat', embModel: '', embDims: 0 },
  { id: 'xai', name: 'xAI (Grok)', kind: 'cloud', group: 'advanced', order: 2, icon: '✦', desc: 'Grok models', needsKey: true, placeholder: 'xai-...', baseUrl: 'https://api.x.ai', llmModel: 'grok-2', embModel: '', embDims: 0 },
  { id: 'openai-compatible', name: 'Custom API server', kind: 'cloud', group: 'advanced', order: 3, icon: '~', desc: 'Connect any AI server that uses the standard OpenAI API format.', needsKey: false, needsUrl: true, optionalKey: true, placeholder: 'API key (optional)', baseUrl: '', llmModel: '', embModel: '', embDims: 0 },
];

// ── Local ("runs on this computer") provider ids ─────────────────────────────
// Single source of truth: previously duplicated across five sites with three
// different, drifting sets. Derived from the PROVIDERS catalog (kind === 'local')
// so adding a local provider there keeps this in sync, plus a small set of host-
// only runtimes that are detected on the machine (via host-info / OpenCode) but
// aren't offered as selectable wizard providers, so they never appear in PROVIDERS.
const HOST_ONLY_LOCAL_PROVIDER_IDS = ['llamacpp', 'localai'] as const;

/** Provider connIds whose models run on the user's own machine. */
export const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set<string>([
  ...PROVIDERS.filter((p) => p.kind === 'local').map((p) => p.id),
  ...HOST_ONLY_LOCAL_PROVIDER_IDS,
]);

// ── Friendly provider display names ──────────────────────────────────────────
/** Curated, human-facing labels for well-known cloud provider connIds. */
export const FRIENDLY_PROVIDER_NAMES: Record<string, string> = {
  openai: 'ChatGPT (OpenAI)',
  google: 'Gemini (Google)',
  'github-copilot': 'GitHub Copilot',
  groq: 'Groq',
  anthropic: 'Claude (Anthropic)',
  mistral: 'Mistral',
  cohere: 'Cohere',
};

/**
 * Human-facing display name for a provider connId. Prefers a curated friendly
 * name, then (for local runtimes) the caller's `localLabel`, then a name from
 * `extraProviders` (e.g. live OpenCode providers) or the static PROVIDERS
 * catalog, finally falling back to the raw connId.
 */
export function friendlyProviderName(
  connId: string,
  opts: { localLabel?: string; extraProviders?: readonly { id: string; name: string }[] } = {},
): string {
  if (!connId) return '';
  const friendly = FRIENDLY_PROVIDER_NAMES[connId];
  if (friendly) return friendly;
  if (opts.localLabel && LOCAL_PROVIDER_IDS.has(connId)) return opts.localLabel;
  const dynamic = opts.extraProviders?.find((p) => p.id === connId)?.name;
  if (dynamic) return dynamic;
  return PROVIDERS.find((p) => p.id === connId)?.name ?? connId;
}

export const STEP_LABELS = ['Models', 'Extras', 'Review'];

/** Provider IDs excluded from the setup wizard's OAuth provider list. */
export const WIZARD_EXCLUDED_PROVIDERS = new Set(['anthropic']);
export const MAX_VISIBLE_MODELS = 6;

export const PORTALS: Portal[] = [
  { id: 'api', name: 'OpenAI-compatible API', icon: '🔌', desc: 'Let apps that expect an OpenAI-style API talk to your assistant' },
  {
    id: 'discord', name: 'Discord', icon: '🎮', desc: 'Connect to a Discord server',
    credentials: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'Paste Discord bot token', required: true },
      { key: 'applicationId', label: 'Application ID', placeholder: 'Discord application ID', secret: false },
    ]
  },
  {
    id: 'slack', name: 'Slack', icon: '💼', desc: 'Access via Slack bot',
    credentials: [
      { key: 'slackBotToken', label: 'Bot Token', placeholder: 'xoxb-...', required: true },
      { key: 'slackAppToken', label: 'App Token', placeholder: 'xapp-...', required: true },
    ]
  },
];

export const LOCAL_PROVIDERS: OpenCodeProvider[] = [
  { id: 'ollama', name: 'Ollama', env: [], models: {}, localUrl: 'http://localhost:11434' },
  { id: 'model-runner', name: 'Docker Model Runner', env: [], models: {}, localUrl: 'http://localhost:12434' },
  { id: 'lmstudio', name: 'LM Studio', env: [], models: {}, localUrl: 'http://localhost:1234' },
  { id: 'openai-compatible', name: 'Custom API server', env: [], models: {}, localUrl: '' },
];
