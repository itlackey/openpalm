import type { Provider, ProviderGroup, TtsOption, SttOption, Channel, Service, OpenCodeProvider } from './types.js';

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
  { id: 'openai-compatible', name: 'Custom (OpenAI-compatible)', kind: 'cloud', group: 'advanced', order: 3, icon: '🔧', desc: 'Any endpoint that speaks the OpenAI API', needsKey: false, needsUrl: true, optionalKey: true, placeholder: 'API key (optional)', baseUrl: '', llmModel: '', embModel: '', embDims: 0 },
];

export const KNOWN_EMB_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536, 'nomic-embed-text': 768,
  'mxbai-embed-large': 1024, 'mxbai-embed-large-v1': 1024,
  'ai/mxbai-embed-large-v1': 1024, 'mistral-embed': 1024,
  'all-minilm': 384, 'snowflake-arctic-embed': 1024,
  'intfloat/multilingual-e5-large': 1024,
};

export const STEP_LABELS = ['Welcome', 'Providers', 'Models', 'Voice', 'Options', 'Review'];
export const MAX_VISIBLE_MODELS = 6;

export const TTS_OPTIONS: TtsOption[] = [
  { id: 'kokoro', name: 'Kokoro TTS', type: 'local', recommended: true, desc: 'High-quality local TTS — runs on CPU' },
  { id: 'piper', name: 'Piper TTS', type: 'local', desc: 'Ultra-lightweight — great for low-power hardware' },
  { id: 'openai-tts', name: 'OpenAI TTS', type: 'cloud', desc: 'Cloud voices. Uses your OpenAI API key' },
  { id: 'browser-tts', name: 'Browser Built-in', type: 'builtin', desc: 'Native speech synthesis. No setup needed' },
  { id: 'skip-tts', name: 'Skip — text only', type: 'skip', desc: 'Add TTS later from the dashboard' },
];

export const STT_OPTIONS: SttOption[] = [
  { id: 'whisper-local', name: 'Whisper (local)', type: 'local', recommended: true, desc: 'Whisper in Docker. Accurate, private' },
  { id: 'openai-stt', name: 'OpenAI Whisper', type: 'cloud', desc: 'Cloud Whisper API. Uses OpenAI key' },
  { id: 'browser-stt', name: 'Browser Built-in', type: 'builtin', desc: 'Web Speech API. No setup' },
  { id: 'skip-stt', name: 'Skip — text only', type: 'skip', desc: 'Add STT later from the dashboard' },
];

export const CHANNELS: Channel[] = [
  { id: 'chat', name: 'Web Chat', icon: '💬', desc: 'Browser-based chat — always available', locked: true },
  { id: 'api', name: 'API', icon: '🔌', desc: 'OpenAI-compatible REST API endpoint' },
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

export const SERVICES: Service[] = [
  { id: 'admin', name: 'Admin Dashboard', icon: '⚙️', desc: 'Web-based admin UI for managing your stack', recommended: true },
];

export const LOCAL_PROVIDERS: OpenCodeProvider[] = [
  { id: 'ollama', name: 'Ollama', env: [], models: {}, localUrl: 'http://localhost:11434' },
  { id: 'model-runner', name: 'Docker Model Runner', env: [], models: {}, localUrl: 'http://localhost:12434' },
  { id: 'lmstudio', name: 'LM Studio', env: [], models: {}, localUrl: 'http://localhost:1234' },
  { id: 'openai-compatible', name: 'Custom (OpenAI-compatible)', env: [], models: {}, localUrl: '' },
];
