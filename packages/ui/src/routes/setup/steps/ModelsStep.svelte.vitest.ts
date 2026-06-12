import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ModelsStep from './ModelsStep.svelte';
import type { Provider, ProviderState } from '$lib/wizard/types.js';

const ollamaProvider: Provider = {
  id: 'ollama',
  name: 'Ollama',
  group: 'local',
  kind: 'local',
  order: 1,
  icon: 'O',
  desc: 'Local models',
  baseUrl: 'http://localhost:11434',
  llmModel: 'llama3.2',
  embModel: 'nomic-embed-text',
  embDims: 768,
};

const providerState: Record<string, ProviderState> = {
  ollama: {
    selected: true,
    verified: true,
    verifying: false,
    error: false,
    apiKey: '',
    baseUrl: 'http://localhost:11434',
    models: ['llama3.2', 'mxbai-embed-large'],
    ollamaMode: 'running',
  },
};

describe('ModelsStep', () => {
  test('does not render hidden compatibility inputs', async () => {
    render(ModelsStep, {
      props: {
        verifiedProviders: [ollamaProvider],
        providerState,
        modelSelection: {},
        allowEmptyInstall: false,
        canComplete: false,
        errorMessage: '',
        onback: vi.fn(),
        onnext: vi.fn(),
        onselect: vi.fn(),
        onselectnone: vi.fn(),
      },
    });

    await expect.element(page.getByRole('button', { name: 'Voice Setup' })).toBeDisabled();
    const llmOption = document.querySelector('[data-model-select="llm:ollama:llama3.2:0"]');
    expect(llmOption).not.toBeNull();
    expect(document.querySelector('#llm-connection')).toBeNull();
    expect(document.querySelector('#llm-model')).toBeNull();
    expect(document.querySelector('#emb-model')).toBeNull();
  });

  test('reports selection through callbacks instead of hidden fields', async () => {
    const onselect = vi.fn();
    render(ModelsStep, {
      props: {
        verifiedProviders: [ollamaProvider],
        providerState,
        modelSelection: {},
        allowEmptyInstall: false,
        canComplete: false,
        errorMessage: '',
        onback: vi.fn(),
        onnext: vi.fn(),
        onselect,
        onselectnone: vi.fn(),
      },
    });

    const llmOption = document.querySelector<HTMLElement>('[data-model-select="llm:ollama:llama3.2:0"]');
    expect(llmOption).not.toBeNull();
    llmOption?.click();
    expect(onselect).toHaveBeenCalledWith('llm', 'ollama', 'llama3.2', 0);
  });
});
