import { describe, expect, it } from 'vitest';
import {
  WIZARD_CONNECTION_KINDS,
  WIZARD_REQUIRED_CAPABILITIES,
  WIZARD_OPTIONAL_CAPABILITIES,
  getWizardConnectionKindForProvider,
  isWizardCapability,
  isWizardProviderInScope,
  validateWizardCapabilitiesInput,
} from './scope.js';

describe('setup wizard v1 scope', () => {
  it('defines only the two allowed connection kinds', () => {
    expect(WIZARD_CONNECTION_KINDS).toEqual([
      'openai_compatible_remote',
      'openai_compatible_local',
    ]);
  });

  it('defines required and optional capabilities per scope decision', () => {
    expect(WIZARD_REQUIRED_CAPABILITIES).toEqual(['llm', 'embeddings']);
    expect(WIZARD_OPTIONAL_CAPABILITIES).toEqual(['reranking', 'tts', 'stt']);
  });

  it('accepts only v1 in-scope providers', () => {
    expect(isWizardProviderInScope('openai')).toBe(true);
    expect(isWizardProviderInScope('ollama')).toBe(true);
    expect(isWizardProviderInScope('anthropic')).toBe(false);
    expect(getWizardConnectionKindForProvider('openai')).toBe('openai_compatible_remote');
    expect(getWizardConnectionKindForProvider('ollama')).toBe('openai_compatible_local');
  });

  it('validates capability payloads and required capability presence', () => {
    expect(validateWizardCapabilitiesInput(undefined)).toEqual({
      ok: true,
      capabilities: ['llm', 'embeddings'],
    });
    expect(validateWizardCapabilitiesInput(['llm', 'embeddings', 'tts'])).toEqual({
      ok: true,
      capabilities: ['llm', 'embeddings', 'tts'],
    });

    const missingRequired = validateWizardCapabilitiesInput(['llm']);
    expect(missingRequired.ok).toBe(false);
    if (!missingRequired.ok) {
      expect(missingRequired.message).toContain('required values: embeddings');
    }

    const invalid = validateWizardCapabilitiesInput(['llm', 'embeddings', 'voice']);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.message).toContain('unsupported value: voice');
    }
  });

  it('validates capability symbols', () => {
    expect(isWizardCapability('llm')).toBe(true);
    expect(isWizardCapability('stt')).toBe(true);
    expect(isWizardCapability('search')).toBe(false);
  });
});
