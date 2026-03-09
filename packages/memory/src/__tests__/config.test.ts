import { describe, test, expect } from 'bun:test';
import { resolveConfig } from '../config.js';

describe('resolveConfig', () => {
  test('returns defaults when no config provided', () => {
    const config = resolveConfig({});
    expect(config.llm?.provider).toBe('openai');
    expect(config.embedder?.provider).toBe('openai');
    expect(config.vectorStore?.provider).toBe('sqlite-vec');
  });

  test('preserves user-provided llm config', () => {
    const config = resolveConfig({
      llm: { provider: 'ollama', config: { model: 'llama3' } },
    });
    expect(config.llm?.provider).toBe('ollama');
    expect(config.llm?.config.model).toBe('llama3');
  });

  test('preserves user-provided embedder config', () => {
    const config = resolveConfig({
      embedder: { provider: 'ollama', config: { model: 'nomic-embed-text' } },
    });
    expect(config.embedder?.provider).toBe('ollama');
  });

  test('preserves user-provided vectorStore config', () => {
    const config = resolveConfig({
      vectorStore: {
        provider: 'sqlite-vec',
        config: { dbPath: '/custom/path.db', dimensions: 768 },
      },
    });
    expect(config.vectorStore?.config.dbPath).toBe('/custom/path.db');
    expect(config.vectorStore?.config.dimensions).toBe(768);
  });

  test('preserves customPrompt', () => {
    const config = resolveConfig({ customPrompt: 'Be concise' });
    expect(config.customPrompt).toBe('Be concise');
  });
});
