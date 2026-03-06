import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SUPPORTED_CONNECTION_KINDS_V1,
  REQUIRED_CAPABILITIES_V1,
  OPTIONAL_CAPABILITIES_V1,
  WIZARD_CAPABILITIES,
  getWizardConnectionKindForProvider,
  isWizardProviderInScope,
  validateWizardCapabilitiesInput,
} from '../../admin/src/lib/setup-wizard/scope.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

function readRoute(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('R01-3 setup-wizard v1 constants', () => {
  it('includes only v1 remote/local kinds', () => {
    expect(SUPPORTED_CONNECTION_KINDS_V1).toEqual([
      'openai_compatible_remote',
      'openai_compatible_local',
    ]);
    expect(SUPPORTED_CONNECTION_KINDS_V1).not.toContain('ollama_native');
  });

  it('includes required and optional capability sets for v1', () => {
    expect(REQUIRED_CAPABILITIES_V1).toEqual(['llm', 'embeddings']);
    expect(OPTIONAL_CAPABILITIES_V1).toEqual(['reranking', 'tts', 'stt']);
    expect(WIZARD_CAPABILITIES).toEqual([
      'llm',
      'embeddings',
      'reranking',
      'tts',
      'stt',
    ]);
  });
});

describe('R01-3 validateWizardCapabilitiesInput', () => {
  it('accepts default and valid values', () => {
    expect(validateWizardCapabilitiesInput(undefined)).toEqual({
      ok: true,
      capabilities: ['llm', 'embeddings'],
    });

    expect(validateWizardCapabilitiesInput(['llm', 'embeddings', 'tts'])).toEqual({
      ok: true,
      capabilities: ['llm', 'embeddings', 'tts'],
    });

    expect(validateWizardCapabilitiesInput(['llm', 'llm', 'embeddings', 'tts'])).toEqual({
      ok: true,
      capabilities: ['llm', 'embeddings', 'tts'],
    });
  });

  it('rejects unsupported capabilities', () => {
    const result = validateWizardCapabilitiesInput(['llm', 'embeddings', 'vision']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('unsupported value: vision');
    }
  });

  it('rejects capability lists missing required values', () => {
    const resultMissingLlm = validateWizardCapabilitiesInput(['embeddings', 'tts']);
    expect(resultMissingLlm.ok).toBe(false);
    if (!resultMissingLlm.ok) {
      expect(resultMissingLlm.message).toContain('required values: llm');
    }

    const resultMissingEmbeddings = validateWizardCapabilitiesInput(['llm', 'stt']);
    expect(resultMissingEmbeddings.ok).toBe(false);
    if (!resultMissingEmbeddings.ok) {
      expect(resultMissingEmbeddings.message).toContain('required values: embeddings');
    }
  });
});

describe('R01-3 provider scope helpers', () => {
  it('maps and validates in-scope providers', () => {
    expect(getWizardConnectionKindForProvider('openai')).toBe('openai_compatible_remote');
    expect(getWizardConnectionKindForProvider('groq')).toBe('openai_compatible_remote');
    expect(getWizardConnectionKindForProvider('ollama')).toBe('openai_compatible_local');
    expect(getWizardConnectionKindForProvider('lmstudio')).toBe('openai_compatible_local');
    expect(getWizardConnectionKindForProvider('anthropic')).toBeNull();

    expect(isWizardProviderInScope('openai')).toBe(true);
    expect(isWizardProviderInScope('ollama')).toBe(true);
    expect(isWizardProviderInScope('anthropic')).toBe(false);
  });
});

describe('R01-3 route guardrails', () => {
  it('setup route validates provider scope and capabilities', () => {
    const content = readRoute('core/admin/src/routes/admin/setup/+server.ts');

    expect(content).toContain('!isWizardProviderInScope(llmProvider)');
    expect(content).toContain('validateWizardCapabilitiesInput(body.capabilities)');
  });

  it('setup/models route validates provider scope and capability id', () => {
    const content = readRoute('core/admin/src/routes/admin/setup/models/+server.ts');

    expect(content).toContain('!isWizardProviderInScope(provider)');
    expect(content).toContain('capability && !isWizardCapability(capability)');
  });

  it('connections route validates provider scope in unified and legacy patch paths', () => {
    const content = readRoute('core/admin/src/routes/admin/connections/+server.ts');

    expect(content).toContain('!isWizardProviderInScope(provider)');
    expect(content).toContain("key === 'SYSTEM_LLM_PROVIDER' && value && !isWizardProviderInScope(value)");
    expect(content).toContain('validateWizardCapabilitiesInput(body.capabilities)');
  });
});
