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
      llm: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/',
        model: 'gpt-4.1-mini',
        apiKeyRef: 'env:OPENAI_API_KEY',
      },
      embedder: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/',
        model: 'text-embedding-3-small',
        apiKeyRef: 'env:OPENAI_API_KEY',
      },
      embeddingDims: 1536,
      customInstructions: '',
    });

    expect(mapping.mem0.llm.provider).toBe('openai');
    expect(mapping.mem0.llm.config.openai_base_url).toBe('https://api.openai.com/v1');
    expect(mapping.mem0.embedder.config.openai_base_url).toBe('https://api.openai.com/v1');
    expect(mapping.mem0.vector_store.config.embedding_model_dims).toBe(1536);
  });

  test('buildMem0Mapping maps lmstudio to openai provider and keeps deterministic output', () => {
    const input = {
      llm: {
        provider: 'lmstudio',
        baseUrl: 'http://host.docker.internal:1234',
        model: 'qwen3:0.6b',
        apiKeyRef: 'not-needed',
      },
      embedder: {
        provider: 'lmstudio',
        baseUrl: 'http://host.docker.internal:1234',
        model: 'nomic-embed-text',
        apiKeyRef: 'not-needed',
      },
      embeddingDims: 768,
      customInstructions: 'x',
    } as const;

    const first = buildMem0Mapping(input);
    const second = buildMem0Mapping(input);

    expect(first.mem0.llm.provider).toBe('openai');
    expect(first.mem0.llm.config.openai_base_url).toBe('http://host.docker.internal:1234/v1');
    expect(first).toEqual(second);
  });

  test('buildMem0Mapping supports split providers (different LLM and embedder)', () => {
    const mapping = buildMem0Mapping({
      llm: {
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai',
        model: 'llama-3.1-70b',
        apiKeyRef: 'env:GROQ_API_KEY',
      },
      embedder: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/',
        model: 'text-embedding-3-small',
        apiKeyRef: 'env:OPENAI_API_KEY',
      },
      embeddingDims: 1536,
      customInstructions: '',
    });

    // LLM uses Groq (mem0 maps groq → groq provider name)
    expect(mapping.mem0.llm.provider).toBe('groq');
    expect(mapping.mem0.llm.config.model).toBe('llama-3.1-70b');
    expect(mapping.mem0.llm.config.api_key).toBe('env:GROQ_API_KEY');

    // Embedder uses OpenAI
    expect(mapping.mem0.embedder.provider).toBe('openai');
    expect(mapping.mem0.embedder.config.model).toBe('text-embedding-3-small');
    expect(mapping.mem0.embedder.config.api_key).toBe('env:OPENAI_API_KEY');
    expect(mapping.mem0.embedder.config.openai_base_url).toBe('https://api.openai.com/v1');
  });

  test('buildMem0Mapping supports ollama LLM with openai embedder', () => {
    const mapping = buildMem0Mapping({
      llm: {
        provider: 'ollama',
        baseUrl: 'http://ollama:11434',
        model: 'llama3.2:3b',
        apiKeyRef: 'not-needed',
      },
      embedder: {
        provider: 'openai',
        baseUrl: '',
        model: 'text-embedding-3-small',
        apiKeyRef: 'env:OPENAI_API_KEY',
      },
      embeddingDims: 1536,
      customInstructions: '',
    });

    // LLM uses Ollama
    expect(mapping.mem0.llm.provider).toBe('ollama');
    expect(mapping.mem0.llm.config.model).toBe('llama3.2:3b');
    expect(mapping.mem0.llm.config.ollama_base_url).toBe('http://ollama:11434');

    // Embedder uses OpenAI (no base URL override needed)
    expect(mapping.mem0.embedder.provider).toBe('openai');
    expect(mapping.mem0.embedder.config.model).toBe('text-embedding-3-small');
    expect(mapping.mem0.embedder.config).not.toHaveProperty('openai_base_url');
  });
});
