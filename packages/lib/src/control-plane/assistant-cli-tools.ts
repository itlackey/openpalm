import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ControlPlaneState } from './types.js';
import { assistantServiceDir, authJsonPath } from './paths.js';

export type AssistantCliToolId = 'codex' | 'claude' | 'copilot' | 'pi';

export type AssistantCliProviderMapping = {
  providerId: string;
  label: string;
};

export type AssistantCliToolStatus = {
  id: AssistantCliToolId;
  name: string;
  configured: boolean;
  configPaths: string[];
  availableProviderMappings: AssistantCliProviderMapping[];
};

type OpenCodeAuthEntry = {
  type?: string;
  key?: unknown;
};

const PI_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  google: 'Google Gemini',
  groq: 'Groq',
  mistral: 'Mistral',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
  openrouter: 'OpenRouter',
  xai: 'xAI',
};

const PI_PROVIDER_ORDER = [
  'anthropic',
  'openai',
  'google',
  'groq',
  'mistral',
  'deepseek',
  'openrouter',
  'xai',
  'opencode',
  'opencode-go',
] as const;

function readOpenCodeApiKeys(state: ControlPlaneState): Record<string, string> {
  const path = authJsonPath(state);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, OpenCodeAuthEntry>;
    const keys: Record<string, string> = {};
    for (const [providerId, entry] of Object.entries(raw)) {
      if (entry?.type === 'api' && typeof entry.key === 'string' && entry.key.trim()) {
        keys[providerId] = entry.key;
      }
    }
    return keys;
  } catch {
    return {};
  }
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writePrivateFile(path: string, content: string): void {
  ensureParentDir(path);
  writeFileSync(path, content, { mode: 0o600 });
}

function updateCodexConfigToml(path: string): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const preferred = 'preferred_auth_method = "apikey"';
  if (!existing.trim()) {
    writePrivateFile(path, `${preferred}\n`);
    return;
  }

  const replaced = existing.match(/^\s*preferred_auth_method\s*=.*$/m)
    ? existing.replace(/^\s*preferred_auth_method\s*=.*$/m, preferred)
    : `${existing.replace(/\s*$/, '\n')}${preferred}\n`;
  writePrivateFile(path, replaced);
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function codexPaths(state: ControlPlaneState): { authPath: string; configPath: string } {
  const home = assistantServiceDir(state);
  return {
    authPath: `${home}/.codex/auth.json`,
    configPath: `${home}/.codex/config.toml`,
  };
}

function piAuthPath(state: ControlPlaneState): string {
  return `${assistantServiceDir(state)}/.pi/agent/auth.json`;
}

export function listAssistantCliTools(state: ControlPlaneState): AssistantCliToolStatus[] {
  const authKeys = readOpenCodeApiKeys(state);
  const codex = codexPaths(state);
  const piMappings = PI_PROVIDER_ORDER
    .filter((providerId) => authKeys[providerId])
    .map((providerId) => ({ providerId, label: PI_PROVIDER_LABELS[providerId] ?? providerId }));

  return [
    {
      id: 'codex',
      name: 'Codex CLI',
      configured: existsSync(codex.authPath) || existsSync(codex.configPath),
      configPaths: [codex.authPath, codex.configPath],
      availableProviderMappings: authKeys.openai ? [{ providerId: 'openai', label: 'OpenAI' }] : [],
    },
    {
      id: 'claude',
      name: 'Claude Code',
      configured: existsSync(`${assistantServiceDir(state)}/.claude/.credentials.json`),
      configPaths: [`${assistantServiceDir(state)}/.claude/.credentials.json`],
      availableProviderMappings: [],
    },
    {
      id: 'copilot',
      name: 'GitHub Copilot CLI',
      configured: existsSync(`${assistantServiceDir(state)}/.copilot/config.json`) || existsSync(`${assistantServiceDir(state)}/.copilot/settings.json`),
      configPaths: [
        `${assistantServiceDir(state)}/.copilot/config.json`,
        `${assistantServiceDir(state)}/.copilot/settings.json`,
      ],
      availableProviderMappings: [],
    },
    {
      id: 'pi',
      name: 'Pi CLI',
      configured: existsSync(piAuthPath(state)),
      configPaths: [piAuthPath(state)],
      availableProviderMappings: piMappings,
    },
  ];
}

export function useExistingProviderForAssistantCli(
  state: ControlPlaneState,
  toolId: AssistantCliToolId,
  providerId: string,
): string[] {
  const authKeys = readOpenCodeApiKeys(state);
  const apiKey = authKeys[providerId];
  if (!apiKey) {
    throw new Error(`Provider ${providerId} is not available for ${toolId}`);
  }

  if (toolId === 'codex') {
    if (providerId !== 'openai') {
      throw new Error('Codex only supports the OpenAI provider mapping');
    }
    const { authPath, configPath } = codexPaths(state);
    writePrivateFile(authPath, `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`);
    updateCodexConfigToml(configPath);
    return [authPath, configPath];
  }

  if (toolId === 'pi') {
    const path = piAuthPath(state);
    const current = readJsonObject(path);
    current[providerId] = { type: 'api_key', key: apiKey };
    writePrivateFile(path, `${JSON.stringify(current, null, 2)}\n`);
    return [path];
  }

  throw new Error(`Direct provider mapping is not available for ${toolId}`);
}
