import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildMem0Mapping, buildOpenCodeMapping, writeOpenCodeProviderConfig } from './connection-mapping.js';

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

  test('buildMem0Mapping maps ollama to openai provider with openai_base_url', () => {
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

    // LLM uses Ollama via OpenAI-compatible protocol (mem0 maps ollama → openai)
    expect(mapping.mem0.llm.provider).toBe('openai');
    expect(mapping.mem0.llm.config.model).toBe('llama3.2:3b');
    expect(mapping.mem0.llm.config.openai_base_url).toBe('http://ollama:11434/v1');

    // Embedder uses OpenAI (no base URL override needed)
    expect(mapping.mem0.embedder.provider).toBe('openai');
    expect(mapping.mem0.embedder.config.model).toBe('text-embedding-3-small');
    expect(mapping.mem0.embedder.config).not.toHaveProperty('openai_base_url');
  });

  test('buildOpenCodeMapping includes options.baseURL when baseUrl is non-empty', () => {
    const mapping = buildOpenCodeMapping({
      provider: 'lmstudio',
      baseUrl: 'http://host.docker.internal:1234',
      systemModel: 'qwen3:8b',
    });

    expect(mapping.provider).toBe('lmstudio');
    expect(mapping.model).toBe('qwen3:8b');
    expect(mapping.smallModel).toBe('qwen3:8b');
    expect(mapping.options?.baseURL).toBe('http://host.docker.internal:1234');
  });

  test('buildOpenCodeMapping sets both model and smallModel to systemModel', () => {
    const mapping = buildOpenCodeMapping({
      provider: 'openai',
      baseUrl: '',
      systemModel: 'gpt-4o',
    });

    expect(mapping.model).toBe('gpt-4o');
    expect(mapping.smallModel).toBe('gpt-4o');
    expect(mapping.options).toBeUndefined();
  });

  test('writeOpenCodeProviderConfig preserves existing provider settings while updating baseURL', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openpalm-connection-mapping-'));
    const assistantDir = join(configDir, 'assistant');
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(
      join(assistantDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        providers: {
          openai: {
            retries: 3,
            options: {
              timeout: 10_000,
              baseURL: 'https://old.example.com/v1',
            },
          },
        },
      }, null, 2) + '\n',
    );

    writeOpenCodeProviderConfig(configDir, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      smallModel: 'gpt-4.1-mini',
      options: { baseURL: 'https://api.openai.com/v1' },
    });

    const updated = JSON.parse(readFileSync(join(assistantDir, 'opencode.json'), 'utf-8')) as {
      providers: {
        openai: {
          retries: number;
          options: {
            timeout: number;
            baseURL: string;
          };
        };
      };
    };

    expect(updated.providers.openai.retries).toBe(3);
    expect(updated.providers.openai.options.timeout).toBe(10_000);
    expect(updated.providers.openai.options.baseURL).toBe('https://api.openai.com/v1');

    rmSync(configDir, { recursive: true, force: true });
  });

  test('writeOpenCodeProviderConfig clears stale provider baseURL when mapping omits one', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openpalm-connection-mapping-'));
    const assistantDir = join(configDir, 'assistant');
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(
      join(assistantDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        providers: {
          openai: {
            options: {
              timeout: 10_000,
              baseURL: 'https://old.example.com/v1',
            },
          },
        },
      }, null, 2) + '\n',
    );

    writeOpenCodeProviderConfig(configDir, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      smallModel: 'gpt-4.1-mini',
    });

    const updated = JSON.parse(readFileSync(join(assistantDir, 'opencode.json'), 'utf-8')) as {
      providers: {
        openai: {
          options: {
            timeout: number;
            baseURL?: string;
          };
        };
      };
    };

    expect(updated.providers.openai.options.timeout).toBe(10_000);
    expect(updated.providers.openai.options.baseURL).toBeUndefined();

    rmSync(configDir, { recursive: true, force: true });
  });

  test('writeOpenCodeProviderConfig leaves an unreadable existing config untouched', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openpalm-connection-mapping-'));
    const assistantDir = join(configDir, 'assistant');
    mkdirSync(assistantDir, { recursive: true });
    const configPath = join(assistantDir, 'opencode.json');
    writeFileSync(configPath, '{not-json}\n');

    writeOpenCodeProviderConfig(configDir, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      smallModel: 'gpt-4.1-mini',
      options: { baseURL: 'https://api.openai.com' },
    });

    expect(readFileSync(configPath, 'utf-8')).toBe('{not-json}\n');

    rmSync(configDir, { recursive: true, force: true });
  });

  test('buildMem0Mapping with two separate connections emits correct per-side baseUrl', () => {
    const mapping = buildMem0Mapping({
      llm: {
        provider: 'lmstudio',
        baseUrl: 'http://host.docker.internal:1234',
        model: 'mistral-7b',
        apiKeyRef: 'not-needed',
      },
      embedder: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/',
        model: 'text-embedding-3-large',
        apiKeyRef: 'env:OPENAI_API_KEY',
      },
      embeddingDims: 3072,
      customInstructions: 'Be concise.',
    });

    expect(mapping.mem0.llm.provider).toBe('openai');
    expect(mapping.mem0.llm.config.openai_base_url).toBe('http://host.docker.internal:1234/v1');
    expect(mapping.mem0.llm.config.model).toBe('mistral-7b');

    expect(mapping.mem0.embedder.provider).toBe('openai');
    expect(mapping.mem0.embedder.config.model).toBe('text-embedding-3-large');
    expect(mapping.mem0.embedder.config.openai_base_url).toBe('https://api.openai.com/v1');
    expect(mapping.mem0.embedder.config.api_key).toBe('env:OPENAI_API_KEY');

    expect(mapping.mem0.vector_store.config.embedding_model_dims).toBe(3072);
    expect(mapping.memory.custom_instructions).toBe('Be concise.');
  });

  test('buildMem0Mapping with two cloud connections on different providers has isolated api_key refs', () => {
    const mapping = buildMem0Mapping({
      llm: {
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai',
        model: 'llama-3.3-70b',
        apiKeyRef: 'env:GROQ_API_KEY',
      },
      embedder: {
        provider: 'mistral',
        baseUrl: 'https://api.mistral.ai',
        model: 'mistral-embed',
        apiKeyRef: 'env:MISTRAL_API_KEY',
      },
      embeddingDims: 1024,
      customInstructions: '',
    });

    expect(mapping.mem0.llm.provider).toBe('groq');
    expect(mapping.mem0.llm.config.api_key).toBe('env:GROQ_API_KEY');

    expect(mapping.mem0.embedder.provider).toBe('mistral');
    expect(mapping.mem0.embedder.config.api_key).toBe('env:MISTRAL_API_KEY');
    expect(mapping.mem0.embedder.config.model).toBe('mistral-embed');

    expect(mapping.mem0.embedder.config.api_key).not.toBe('env:GROQ_API_KEY');
  });

  test('buildMem0Mapping does not set openai_base_url when provider has no URL mapping', () => {
    const mapping = buildMem0Mapping({
      llm: {
        provider: 'anthropic',
        baseUrl: '',
        model: 'claude-3-5-sonnet-20241022',
        apiKeyRef: 'env:ANTHROPIC_API_KEY',
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

    expect(mapping.mem0.llm.provider).toBe('anthropic');
    expect(mapping.mem0.llm.config).not.toHaveProperty('openai_base_url');
    expect(mapping.mem0.embedder.config).not.toHaveProperty('openai_base_url');
  });

  test('buildMem0Mapping empty customInstructions sets memory.custom_instructions to empty string', () => {
    const mapping = buildMem0Mapping({
      llm: {
        provider: 'openai',
        baseUrl: '',
        model: 'gpt-4.1-mini',
        apiKeyRef: 'env:OPENAI_API_KEY',
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

    expect(mapping.memory.custom_instructions).toBe('');
  });
});
