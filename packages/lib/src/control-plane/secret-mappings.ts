import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ControlPlaneState } from './types.js';

export type SecretScope = 'user' | 'system';
export type SecretKind = 'core' | 'component' | 'custom';

export type SecretEntryMetadata = {
  key: string;
  scope: SecretScope;
  kind: SecretKind;
  provider: 'plaintext' | 'pass';
  present: boolean;
  envKey?: string;
  updatedAt?: string;
};

export type IndexedSecretEntry = {
  envKey: string;
  scope: SecretScope;
  kind: Exclude<SecretKind, 'core'>;
  updatedAt: string;
};

type CoreSecretMapping = {
  secretKey: string;
  envKey: string;
  scope: SecretScope;
};

const STATIC_CORE_MAPPINGS: CoreSecretMapping[] = [
  // Core authentication tokens
  { secretKey: 'openpalm/admin-token', envKey: 'OP_ADMIN_TOKEN', scope: 'system' },
  { secretKey: 'openpalm/assistant-token', envKey: 'OP_ASSISTANT_TOKEN', scope: 'system' },
  { secretKey: 'openpalm/memory/auth-token', envKey: 'OP_MEMORY_TOKEN', scope: 'system' },
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
  { secretKey: 'openpalm/openviking/api-key', envKey: 'OPENVIKING_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/openviking/vlm-api-key', envKey: 'VLM_API_KEY', scope: 'user' },
  // Channel-specific credentials
  { secretKey: 'openpalm/discord/bot-token', envKey: 'DISCORD_BOT_TOKEN', scope: 'user' },
  { secretKey: 'openpalm/slack/bot-token', envKey: 'SLACK_BOT_TOKEN', scope: 'user' },
  { secretKey: 'openpalm/slack/app-token', envKey: 'SLACK_APP_TOKEN', scope: 'user' },
  { secretKey: 'openpalm/voice/stt-api-key', envKey: 'STT_API_KEY', scope: 'user' },
  { secretKey: 'openpalm/voice/tts-api-key', envKey: 'TTS_API_KEY', scope: 'user' },
];

// 128 bits of the SHA-256 digest keeps collision risk negligible while
// leaving enough room for the OP_SECRET_ prefix in env var names.
const HASH_PREFIX_LENGTH = 32;

type SecretIndexFile = {
  entries: Record<string, IndexedSecretEntry>;
};

function secretIndexPath(state: ControlPlaneState): string {
  return `${state.dataDir}/secrets/plaintext-index.json`;
}

function normalizeIndexedKey(key: string): string {
  return key.trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export function sanitizeSecretSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function secretKeyFromComponentField(instanceId: string, fieldName: string): string {
  return `openpalm/component/${sanitizeSecretSegment(instanceId)}/${sanitizeSecretSegment(fieldName)}`;
}

export function classifySecretKey(key: string): SecretKind {
  if (key.startsWith('openpalm/component/')) return 'component';
  if (key.startsWith('openpalm/custom/')) return 'custom';
  return 'core';
}

export function generatePlaintextEnvKey(secretKey: string): string {
  const digest = createHash('sha256').update(secretKey).digest('hex').slice(0, HASH_PREFIX_LENGTH).toUpperCase();
  return `OP_SECRET_${digest}`;
}

export function classifySecretScope(key: string): SecretScope {
  if (key.startsWith('openpalm/component/')) return 'system';
  if (key.startsWith('openpalm/custom/')) return 'user';
  const coreMapping = STATIC_CORE_MAPPINGS.find((m) => m.secretKey === key);
  if (coreMapping) return coreMapping.scope;
  return 'system';
}

export function getCoreSecretMappings(systemEnv: Record<string, string>): CoreSecretMapping[] {
  const dynamicMappings: CoreSecretMapping[] = [];
  for (const envKey of Object.keys(systemEnv)) {
    const match = envKey.match(/^CHANNEL_([A-Z0-9_]+)_SECRET$/);
    if (!match?.[1]) continue;
    dynamicMappings.push({
      secretKey: `openpalm/channel/${match[1].toLowerCase()}/secret`,
      envKey,
      scope: 'system',
    });
  }
  return [...STATIC_CORE_MAPPINGS, ...dynamicMappings];
}

export function findCoreSecretByKey(
  key: string,
  systemEnv: Record<string, string>,
): CoreSecretMapping | null {
  return getCoreSecretMappings(systemEnv).find((entry) => entry.secretKey === key) ?? null;
}

export function findCoreSecretByEnvKey(
  envKey: string,
  systemEnv: Record<string, string>,
): CoreSecretMapping | null {
  return getCoreSecretMappings(systemEnv).find((entry) => entry.envKey === envKey) ?? null;
}

export function readPlaintextSecretIndex(state: ControlPlaneState): SecretIndexFile {
  const path = secretIndexPath(state);
  if (!existsSync(path)) {
    return { entries: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SecretIndexFile;
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

export function writePlaintextSecretIndex(state: ControlPlaneState, index: SecretIndexFile): void {
  const dir = `${state.dataDir}/secrets`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(secretIndexPath(state), JSON.stringify(index, null, 2) + '\n');
}

export function ensurePlaintextSecretEntry(
  state: ControlPlaneState,
  key: string,
  scope?: SecretScope,
): IndexedSecretEntry {
  const normalizedKey = normalizeIndexedKey(key);
  const index = readPlaintextSecretIndex(state);
  const existing = index.entries[normalizedKey];
  if (existing) {
    return existing;
  }

  const entry: IndexedSecretEntry = {
    envKey: generatePlaintextEnvKey(normalizedKey),
    scope: scope ?? (normalizedKey.startsWith('openpalm/component/') ? 'system' : 'user'),
    kind: classifySecretKey(normalizedKey) === 'component' ? 'component' : 'custom',
    updatedAt: new Date().toISOString(),
  };
  index.entries[normalizedKey] = entry;
  writePlaintextSecretIndex(state, index);
  return entry;
}

export function removePlaintextSecretEntry(state: ControlPlaneState, key: string): void {
  const normalizedKey = normalizeIndexedKey(key);
  const index = readPlaintextSecretIndex(state);
  if (!index.entries[normalizedKey]) return;
  delete index.entries[normalizedKey];
  writePlaintextSecretIndex(state, index);
}
