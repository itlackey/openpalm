import type { Provider, ProviderGroup, TtsOption, SttOption, Channel, OpenCodeProvider, VoiceEngineConfig } from './types.js';
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
  { id: 'openai-compatible', name: 'Custom API server', kind: 'cloud', group: 'advanced', order: 3, icon: '🔧', desc: 'Connect any AI server that uses the standard OpenAI API format.', needsKey: false, needsUrl: true, optionalKey: true, placeholder: 'API key (optional)', baseUrl: '', llmModel: '', embModel: '', embDims: 0 },
];

export const STEP_LABELS = ['Models', 'Extras', 'Review'];

/** Provider IDs excluded from the setup wizard's OAuth provider list. */
export const WIZARD_EXCLUDED_PROVIDERS = new Set(['anthropic']);
export const MAX_VISIBLE_MODELS = 6;

export const TTS_OPTIONS: TtsOption[] = [
  { id: 'openpalm-voice', name: 'Built-in voice', type: 'local', recommended: true, desc: 'Free — runs on this computer. Downloads once when you turn it on.' },
  { id: 'openai-tts', name: 'OpenAI voices', type: 'cloud', desc: 'Uses your OpenAI account.' },
  { id: 'elevenlabs-tts', name: 'ElevenLabs', type: 'cloud', desc: 'High-quality voices. Needs an ElevenLabs account.' },
  { id: 'browser-tts', name: 'Your web browser', type: 'builtin', desc: 'Free, no setup needed.' },
  { id: 'skip-tts', name: 'Skip for now', type: 'skip', desc: 'Add voice later from the dashboard.' },
];

export const STT_OPTIONS: SttOption[] = [
  { id: 'openpalm-voice', name: 'Built-in voice', type: 'local', recommended: true, desc: 'Free — runs on this computer. Downloads once when you turn it on.' },
  { id: 'openai-stt', name: 'OpenAI', type: 'cloud', desc: 'Uses your OpenAI account.' },
  { id: 'browser-stt', name: 'Your web browser', type: 'builtin', desc: 'Free, no setup needed.' },
  { id: 'skip-stt', name: 'Skip for now', type: 'skip', desc: 'Add later from the dashboard.' },
];

/**
 * Per-engine configuration fields. Empty `fields` means "no extra settings".
 * `provider` is written to stack.env as OP_TTS_PROVIDER / OP_STT_PROVIDER
 * so the voice channel can resolve the runtime URL.
 *
 * Shared between the setup wizard's VoiceStep and the admin Capabilities tab.
 */
// Field definitions shared by engines that talk to an HTTP backend.
const BASE_URL_FIELD = (placeholder: string, hint: string) => ({
  key: 'baseURL' as const,
  label: 'Endpoint URL',
  placeholder,
  hint,
});

export const TTS_ENGINES: Record<string, VoiceEngineConfig> = {
  // Bundled openpalm/voice container — same engine the admin Voice tab
  // calls 'openpalm-voice'. No URL/model fields: the route writes the
  // loopback preset (http://127.0.0.1:8880, kokoro, bf_isabella) at
  // save time so the operator never has to think about it.
  'openpalm-voice': {
    id: 'openpalm-voice',
    provider: 'openpalm-voice',
    fields: [],
  },
  'openai-tts': {
    id: 'openai-tts',
    provider: 'openai',
    fields: [
      BASE_URL_FIELD(
        'https://api.openai.com/v1',
        'Leave empty to use the default OpenAI endpoint. Override for proxies / Azure-compat.',
      ),
      { key: 'model', label: 'Model', options: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'] },
      { key: 'voice', label: 'Voice', options: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
    ],
  },
  'elevenlabs-tts': {
    id: 'elevenlabs-tts',
    provider: 'elevenlabs',
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'sk_...', hint: 'Your ElevenLabs API key from elevenlabs.io.' },
      { key: 'voice', label: 'Voice ID', placeholder: 'EXAVITQu4vr4xnSDxMaL', hint: 'ElevenLabs voice ID (from your Voice Library).' },
      { key: 'model', label: 'Model', options: ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'] },
    ],
  },
  'browser-tts': {
    id: 'browser-tts',
    fields: [],
  },
  'skip-tts': {
    id: 'skip-tts',
    fields: [],
  },
};

export const STT_ENGINES: Record<string, VoiceEngineConfig> = {
  // Bundled openpalm/voice container (same engine as TTS — one image
  // serves both endpoints). No URL/model fields: the route writes the
  // loopback preset (http://127.0.0.1:8880, whisper-1) at save time.
  'openpalm-voice': {
    id: 'openpalm-voice',
    provider: 'openpalm-voice',
    fields: [],
  },
  'openai-stt': {
    id: 'openai-stt',
    provider: 'openai',
    fields: [
      BASE_URL_FIELD(
        'https://api.openai.com/v1',
        'Leave empty to use the default OpenAI endpoint.',
      ),
      { key: 'model', label: 'Model', options: ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'] },
      { key: 'language', label: 'Language', placeholder: 'en', hint: 'A language code like `en` or `fr`, or leave blank to detect automatically.' },
    ],
  },
  'browser-stt': {
    id: 'browser-stt',
    fields: [
      { key: 'language', label: 'Language', placeholder: 'en-US', hint: 'A language code like `en` or `fr`, or leave blank to detect automatically.' },
    ],
  },
  'skip-stt': {
    id: 'skip-stt',
    fields: [],
  },
};

export const CHANNELS: Channel[] = [
  { id: 'api', name: 'API', icon: '🔌', desc: 'OpenAI-compatible REST API endpoint', locked: true },
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
