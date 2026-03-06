import { describe, expect, test } from 'vitest';
import { buildMem0Mapping, buildOpenCodeMapping } from './connection-mapping.js';

describe('connection mapping', () => {
  test('buildOpenCodeMapping omits options when baseUrl is blank', () => {
    const mapping = buildOpenCodeMapping({
      provider: 'openai',
      baseUrl: '  ',
      systemModel: 'gpt-4.1-mini',
    });

    expect(mapping).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      smallModel: 'gpt-4.1-mini',
    });
  });

  test('buildMem0Mapping normalizes openai-compatible baseUrl with /v1', () => {
    const mapping = buildMem0Mapping({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/',
      systemModel: 'gpt-4.1-mini',
      embeddingModel: 'text-embedding-3-small',
      embeddingDims: 1536,
      apiKeyRef: 'env:OPENAI_API_KEY',
      customInstructions: '',
    });

    expect(mapping.mem0.llm.provider).toBe('openai');
    expect(mapping.mem0.llm.config.openai_base_url).toBe('https://api.openai.com/v1');
    expect(mapping.mem0.embedder.config.openai_base_url).toBe('https://api.openai.com/v1');
    expect(mapping.mem0.vector_store.config.embedding_model_dims).toBe(1536);
  });

  test('buildMem0Mapping maps lmstudio to openai provider and keeps deterministic output', () => {
    const input = {
      provider: 'lmstudio',
      baseUrl: 'http://host.docker.internal:1234',
      systemModel: 'qwen3:0.6b',
      embeddingModel: 'nomic-embed-text',
      embeddingDims: 768,
      apiKeyRef: 'not-needed',
      customInstructions: 'x',
    } as const;

    const first = buildMem0Mapping(input);
    const second = buildMem0Mapping(input);

    expect(first.mem0.llm.provider).toBe('openai');
    expect(first.mem0.llm.config.openai_base_url).toBe('http://host.docker.internal:1234/v1');
    expect(first).toEqual(second);
  });
});
