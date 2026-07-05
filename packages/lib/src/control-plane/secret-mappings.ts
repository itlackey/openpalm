/**
 * Static mapping of the fixed set of core OpenPalm secrets (auth, LLM
 * provider keys, portal credentials) to the env keys the stack reads them
 * from. This is the only part of the secret-mapping surface with a live
 * consumer (`validate.ts`, which checks each `envKey` is present in the
 * runtime env). Everything else that used to live in this file — hashed
 * env-key generation, the plaintext-secret-index CRUD, and the key
 * classifiers for component/custom secrets — had zero consumers and was
 * removed (fable-remediation-plan 3.5).
 */
export type SecretScope = 'user' | 'system';

type CoreSecretMapping = {
  secretKey: string;
  envKey: string;
  scope: SecretScope;
};

export const STATIC_CORE_MAPPINGS: CoreSecretMapping[] = [
  // Core authentication
  { secretKey: 'openpalm/ui-login-password', envKey: 'OP_UI_LOGIN_PASSWORD', scope: 'system' },
  { secretKey: 'openpalm/opencode/server-password', envKey: 'OP_OPENCODE_PASSWORD', scope: 'system' },
  // LLM provider API keys
  { secretKey: 'openpalm/openai/api-key', envKey: 'OPENAI_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/anthropic/api-key', envKey: 'ANTHROPIC_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/groq/api-key', envKey: 'GROQ_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/mistral/api-key', envKey: 'MISTRAL_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/google/api-key', envKey: 'GOOGLE_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/together/api-key', envKey: 'TOGETHER_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/deepseek/api-key', envKey: 'DEEPSEEK_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/xai/api-key', envKey: 'XAI_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/huggingface/token', envKey: 'HF_TOKEN', scope: 'user' },
  { secretKey: 'openpalm/mcp/api-key', envKey: 'MCP_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/embedding/api-key', envKey: 'EMBEDDING_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/lmstudio/api-key', envKey: 'LMSTUDIO_API_KEY', scope: 'user' },
  // Portal-specific credentials
  { secretKey: 'openpalm/discord/bot-token', envKey: 'DISCORD_BOT_TOKEN', scope: 'user' },
  { secretKey: 'openpalm/slack/bot-token', envKey: 'SLACK_BOT_TOKEN', scope: 'user' },
  { secretKey: 'openpalm/slack/app-token', envKey: 'SLACK_APP_TOKEN', scope: 'user' },
  { secretKey: 'openpalm/voice/stt-api-key', envKey: 'STT_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/voice/tts-api-key', envKey: 'TTS_API_KEY', scope: 'user' },
];
