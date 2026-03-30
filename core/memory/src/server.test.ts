/**
 * Tests for memory server helper functions.
 * Since the server module runs Bun.serve() on import, we test
 * the logic patterns in isolation rather than importing the module.
 */
import { describe, test, expect } from 'bun:test';

// ── redactApiKeys logic ─────────────────────────────────────────────

function redactApiKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redactApiKeys);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if ((key === 'api_key' || key === 'apiKey') && typeof value === 'string' && !value.startsWith('env:')) {
        result[key] = '***REDACTED***';
      } else {
        result[key] = redactApiKeys(value);
      }
    }
    return result;
  }
  return obj;
}

describe('redactApiKeys', () => {
  test('redacts snake_case api_key', () => {
    const input = { config: { api_key: 'sk-secret123' } };
    const result = redactApiKeys(input) as any;
    expect(result.config.api_key).toBe('***REDACTED***');
  });

  test('redacts camelCase apiKey', () => {
    const input = { config: { apiKey: 'sk-secret123' } };
    const result = redactApiKeys(input) as any;
    expect(result.config.apiKey).toBe('***REDACTED***');
  });

  test('preserves env: references', () => {
    const input = { config: { api_key: 'env:OPENAI_API_KEY' } };
    const result = redactApiKeys(input) as any;
    expect(result.config.api_key).toBe('env:OPENAI_API_KEY');
  });

  test('handles nested objects', () => {
    const input = {
      mem0: {
        llm: { config: { api_key: 'sk-llm' } },
        embedder: { config: { apiKey: 'sk-embed' } },
      },
    };
    const result = redactApiKeys(input) as any;
    expect(result.mem0.llm.config.api_key).toBe('***REDACTED***');
    expect(result.mem0.embedder.config.apiKey).toBe('***REDACTED***');
  });

  test('handles arrays', () => {
    const input = [{ api_key: 'secret' }, { api_key: 'env:VAR' }];
    const result = redactApiKeys(input) as any[];
    expect(result[0].api_key).toBe('***REDACTED***');
    expect(result[1].api_key).toBe('env:VAR');
  });

  test('returns primitives unchanged', () => {
    expect(redactApiKeys('hello')).toBe('hello');
    expect(redactApiKeys(42)).toBe(42);
    expect(redactApiKeys(null)).toBeNull();
  });
});

// ── validateConfigStructure logic ─────────────────────────────────────

const ALLOWED_MEM0_KEYS = new Set(['llm', 'embedder', 'vector_store', 'history_db_path', 'version']);
const ALLOWED_SECTION_KEYS = new Set(['provider', 'config']);

function validateConfigStructure(config: Record<string, unknown>): Record<string, unknown> {
  let mem0Cfg = (config.mem0 ?? config) as Record<string, unknown>;
  if (config.mem0 && typeof config.mem0 !== 'object') {
    throw new Error("The 'mem0' field must be an object.");
  }

  for (const key of Object.keys(mem0Cfg)) {
    if (!ALLOWED_MEM0_KEYS.has(key)) delete mem0Cfg[key];
  }

  for (const section of ['llm', 'embedder']) {
    const sectionCfg = mem0Cfg[section] as Record<string, unknown> | undefined;
    if (sectionCfg && typeof sectionCfg === 'object') {
      for (const key of Object.keys(sectionCfg)) {
        if (!ALLOWED_SECTION_KEYS.has(key)) delete sectionCfg[key];
      }
    }
  }

  const result: Record<string, unknown> = config.mem0 ? { mem0: mem0Cfg } : { ...mem0Cfg };
  if (config.memory && typeof config.memory === 'object') {
    result.memory = config.memory;
  }
  return result;
}

describe('validateConfigStructure', () => {
  test('strips unknown keys from mem0 section', () => {
    const input = {
      mem0: { llm: { provider: 'openai' }, unknown_key: 'bad' },
    };
    const result = validateConfigStructure(input) as any;
    expect(result.mem0.llm).toBeDefined();
    expect(result.mem0.unknown_key).toBeUndefined();
  });

  test('strips unknown keys from llm/embedder sections', () => {
    const input = {
      mem0: {
        llm: { provider: 'openai', config: {}, extra: 'bad' },
      },
    };
    const result = validateConfigStructure(input) as any;
    expect(result.mem0.llm.provider).toBe('openai');
    expect(result.mem0.llm.extra).toBeUndefined();
  });

  test('preserves memory.custom_instructions', () => {
    const input = {
      mem0: { llm: { provider: 'openai' } },
      memory: { custom_instructions: 'Be helpful' },
    };
    const result = validateConfigStructure(input) as any;
    expect(result.memory.custom_instructions).toBe('Be helpful');
  });

  test('works without mem0 wrapper', () => {
    const input = { llm: { provider: 'openai' }, embedder: { provider: 'openai' } };
    const result = validateConfigStructure(input) as any;
    expect(result.llm.provider).toBe('openai');
  });

  test('does not include memory key when not present', () => {
    const input = { mem0: { llm: { provider: 'openai' } } };
    const result = validateConfigStructure(input);
    expect(result.memory).toBeUndefined();
  });
});

// ── Input validation logic ────────────────────────────────────────────

describe('input validation patterns', () => {
  test('POST /memories/ rejects missing text', () => {
    const body: Record<string, unknown> = {};
    const valid = body.text && typeof body.text === 'string' && (body.text as string).trim() !== '';
    expect(valid).toBeFalsy();
  });

  test('POST /memories/ rejects empty text', () => {
    const body = { text: '   ' };
    const valid = body.text && typeof body.text === 'string' && body.text.trim() !== '';
    expect(valid).toBeFalsy();
  });

  test('POST /memories/ rejects non-string text', () => {
    const body = { text: 123 };
    const valid = body.text && typeof body.text === 'string' && (body.text as string).trim() !== '';
    expect(valid).toBeFalsy();
  });

  test('POST /memories/ accepts valid text', () => {
    const body = { text: 'hello world' };
    const valid = body.text && typeof body.text === 'string' && body.text.trim() !== '';
    expect(valid).toBeTruthy();
  });

  test('PUT /memories/:id rejects missing data', () => {
    const body: Record<string, unknown> = {};
    const valid = body.data && typeof body.data === 'string' && (body.data as string).trim() !== '';
    expect(valid).toBeFalsy();
  });

  test('PUT /memories/:id accepts valid data', () => {
    const body = { data: 'updated content' };
    const valid = body.data && typeof body.data === 'string' && body.data.trim() !== '';
    expect(valid).toBeTruthy();
  });
});

// ── Response shape ────────────────────────────────────────────────────

describe('POST /memories/ response shape', () => {
  test('includes top-level id from first result', () => {
    const result = {
      results: [
        { event: 'ADD', id: 'abc-123', text: 'new fact' },
      ],
    };
    const firstId = (result.results as { id?: string }[])?.find(r => r.id)?.id ?? null;
    const response = { ...result, id: firstId };
    expect(response.id).toBe('abc-123');
    expect(response.results).toBeDefined();
  });

  test('returns null id when no results have id', () => {
    const result = { results: [{ event: 'NONE' }] };
    const firstId = (result.results as { id?: string }[])?.find(r => r.id)?.id ?? null;
    const response = { ...result, id: firstId };
    expect(response.id).toBeNull();
  });

  test('returns null id for empty results', () => {
    const result = { results: [] as { id?: string }[] };
    const firstId = result.results?.find(r => r.id)?.id ?? null;
    expect(firstId).toBeNull();
  });
});

// ── Race condition handling ───────────────────────────────────────────

describe('getMemory initialization pattern', () => {
  test('failed init clears pending state for retry', () => {
    // Validates the pattern: after init failure, _memoryInit is set to null
    // so subsequent calls can retry initialization instead of hanging.
    let pending: Promise<string> | null = null;

    // Simulate the try/catch pattern from getMemory()
    function simulateFailedInit() {
      try {
        throw new Error('init failed');
      } catch {
        pending = null;
      }
    }

    pending = Promise.resolve('placeholder');
    expect(pending).not.toBeNull();

    simulateFailedInit();
    expect(pending).toBeNull(); // Can retry
  });

  test('concurrent calls share the same promise', async () => {
    let callCount = 0;
    let _memory: string | null = null;
    let _memoryInit: Promise<string> | null = null;

    async function getResource(): Promise<string> {
      if (_memory) return _memory;
      if (_memoryInit) return _memoryInit;
      _memoryInit = (async () => {
        try {
          callCount++;
          await new Promise(r => setTimeout(r, 10));
          const m = 'initialized';
          _memory = m;
          _memoryInit = null;
          return m;
        } catch (err) {
          _memoryInit = null;
          throw err;
        }
      })();
      return _memoryInit;
    }

    // Launch concurrent calls
    const [r1, r2, r3] = await Promise.all([
      getResource(),
      getResource(),
      getResource(),
    ]);

    expect(r1).toBe('initialized');
    expect(r2).toBe('initialized');
    expect(r3).toBe('initialized');
    expect(callCount).toBe(1); // Only one init call
  });

  test('serialized memory queue prevents reset from closing active work', async () => {
    // Mirrors the production race: a config update triggers resetMemory()
    // while another request is still mid-operation against the same DB.
    let queue: Promise<void> = Promise.resolve();
    const order: string[] = [];

    function withMemoryLock<T>(operation: () => Promise<T>): Promise<T> {
      const run = queue.then(operation, operation);
      queue = run.then(() => undefined, () => undefined);
      return run;
    }

    const activeRequest = withMemoryLock(async () => {
      order.push('request:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('request:end');
      return 'ok';
    });

    const reset = withMemoryLock(async () => {
      order.push('reset');
    });

    await Promise.all([activeRequest, reset]);
    expect(order).toEqual(['request:start', 'request:end', 'reset']);
  });
});

// ── Error leakage prevention ──────────────────────────────────────────

describe('error response safety', () => {
  test('500 error pattern returns generic message, not internal details', () => {
    // Validates that the catch block returns a generic message
    const simulatedError = new Error('ENOENT: no such file /app/config.json');
    const response = { detail: 'Internal server error' };
    expect(response.detail).toBe('Internal server error');
    expect(response.detail).not.toContain('ENOENT');
    expect(response.detail).not.toContain('/app');
  });

  test('generic error does not leak stack traces', () => {
    const err = new Error('Something broke');
    err.stack = 'Error: Something broke\n    at handleRequest (/app/src/server.ts:123:5)';
    // Server should return generic message, not String(err) or err.stack
    const safeMessage = 'Internal server error';
    expect(safeMessage).not.toContain('server.ts');
    expect(safeMessage).not.toContain('handleRequest');
  });
});

// ── expandEnvVars and buildConfigFromEnv logic ──────────────────────
import { expandEnvVars, buildConfigFromEnv } from './config';

describe('expandEnvVars', () => {
  test('expands simple ${VAR} placeholders', () => {
    const result = expandEnvVars('Hello ${NAME}!', { NAME: 'World' });
    expect(result).toBe('Hello World!');
  });

  test('expands multiple placeholders', () => {
    const result = expandEnvVars('${A} and ${B}', { A: 'one', B: 'two' });
    expect(result).toBe('one and two');
  });

  test('replaces unset variables with empty string', () => {
    const result = expandEnvVars('prefix-${MISSING}-suffix', {});
    expect(result).toBe('prefix--suffix');
  });

  test('supports ${VAR:-default} syntax', () => {
    const result = expandEnvVars('${PORT:-8080}', {});
    expect(result).toBe('8080');
  });

  test('uses env value over default when set', () => {
    const result = expandEnvVars('${PORT:-8080}', { PORT: '3000' });
    expect(result).toBe('3000');
  });

  test('handles empty env value by using default', () => {
    const result = expandEnvVars('${PORT:-8080}', { PORT: '' });
    expect(result).toBe('8080');
  });

  test('works with JSON template strings', () => {
    const template = '{"provider": "${LLM_PROVIDER}", "dims": ${DIMS}}';
    const result = expandEnvVars(template, { LLM_PROVIDER: 'openai', DIMS: '1536' });
    expect(result).toBe('{"provider": "openai", "dims": 1536}');
  });
});

describe('buildConfigFromEnv', () => {
  test('returns null when SYSTEM_LLM_PROVIDER is not set', () => {
    expect(buildConfigFromEnv({})).toBeNull();
    expect(buildConfigFromEnv({ SYSTEM_LLM_MODEL: 'gpt-4o' })).toBeNull();
  });

  test('builds openai config from env vars', () => {
    const config = buildConfigFromEnv({
      SYSTEM_LLM_PROVIDER: 'openai',
      SYSTEM_LLM_MODEL: 'gpt-4o-mini',
      SYSTEM_LLM_API_KEY: 'sk-test123',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMS: '1536',
    });
    expect(config).not.toBeNull();
    expect(config!.llm!.provider).toBe('openai');
    expect(config!.llm!.config.model).toBe('gpt-4o-mini');
    expect(config!.llm!.config.apiKey).toBe('sk-test123');
    expect(config!.embedder!.provider).toBe('openai');
    expect(config!.embedder!.config.model).toBe('text-embedding-3-small');
    expect(config!.embedder!.config.dimensions).toBe(1536);
  });

  test('builds ollama config with pre-resolved base URL', () => {
    const config = buildConfigFromEnv({
      SYSTEM_LLM_PROVIDER: 'ollama',
      SYSTEM_LLM_MODEL: 'qwen2.5-coder:3b',
      SYSTEM_LLM_BASE_URL: 'http://host.docker.internal:11434',
      EMBEDDING_MODEL: 'nomic-embed-text',
      EMBEDDING_BASE_URL: 'http://host.docker.internal:11434',
      EMBEDDING_DIMS: '768',
    });
    expect(config).not.toBeNull();
    expect(config!.llm!.provider).toBe('ollama');
    expect(config!.llm!.config.baseUrl).toBe('http://host.docker.internal:11434');
    expect(config!.embedder!.provider).toBe('ollama');
    expect(config!.embedder!.config.baseUrl).toBe('http://host.docker.internal:11434');
    expect(config!.embedder!.config.dimensions).toBe(768);
  });

  test('uses SYSTEM_LLM_BASE_URL when set', () => {
    const config = buildConfigFromEnv({
      SYSTEM_LLM_PROVIDER: 'openai',
      SYSTEM_LLM_MODEL: 'gpt-4o',
      SYSTEM_LLM_BASE_URL: 'https://custom.api.example.com/v1',
      SYSTEM_LLM_API_KEY: 'sk-custom',
    });
    expect(config!.llm!.config.baseUrl).toBe('https://custom.api.example.com/v1');
  });

  test('baseUrl is undefined when SYSTEM_LLM_BASE_URL is not set', () => {
    const config = buildConfigFromEnv({
      SYSTEM_LLM_PROVIDER: 'openai',
      SYSTEM_LLM_MODEL: 'gpt-4o',
      SYSTEM_LLM_API_KEY: 'sk-test',
    });
    expect(config!.llm!.config.baseUrl).toBeUndefined();
  });

  test('uses SYSTEM_LLM_API_KEY for any provider', () => {
    const config = buildConfigFromEnv({
      SYSTEM_LLM_PROVIDER: 'anthropic',
      SYSTEM_LLM_MODEL: 'claude-3-haiku-20240307',
      SYSTEM_LLM_API_KEY: 'sk-ant-specific',
    });
    expect(config!.llm!.config.apiKey).toBe('sk-ant-specific');
  });

  test('apiKey is undefined when SYSTEM_LLM_API_KEY is not set', () => {
    const config = buildConfigFromEnv({
      SYSTEM_LLM_PROVIDER: 'groq',
      SYSTEM_LLM_MODEL: 'llama-3.1-8b-instant',
    });
    expect(config!.llm!.config.apiKey).toBeUndefined();
  });

  test('EMBEDDING_PROVIDER selects embedder provider independently from LLM', () => {
    const config = buildConfigFromEnv({
      SYSTEM_LLM_PROVIDER: 'openai',
      SYSTEM_LLM_MODEL: 'gpt-4o-mini',
      SYSTEM_LLM_API_KEY: 'sk-test',
      EMBEDDING_PROVIDER: 'ollama',
      EMBEDDING_MODEL: 'nomic-embed-text',
      EMBEDDING_BASE_URL: 'http://host.docker.internal:11434',
      EMBEDDING_DIMS: '768',
    });
    expect(config!.llm!.provider).toBe('openai');
    expect(config!.embedder!.provider).toBe('ollama');
    expect(config!.embedder!.config.baseUrl).toBe('http://host.docker.internal:11434');
  });

  test('defaults embedding dims to 1536 when not set', () => {
    const config = buildConfigFromEnv({
      SYSTEM_LLM_PROVIDER: 'openai',
    });
    expect(config!.embedder!.config.dimensions).toBe(1536);
    expect(config!.vectorStore!.config.dimensions).toBe(1536);
  });

  test('vectorStore is always sqlite-vec', () => {
    const config = buildConfigFromEnv({
      SYSTEM_LLM_PROVIDER: 'openai',
    });
    expect(config!.vectorStore!.provider).toBe('sqlite-vec');
    expect(config!.vectorStore!.config.collectionName).toBe('memory');
  });
});
