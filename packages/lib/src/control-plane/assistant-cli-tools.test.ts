import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState } from './lifecycle.js';
import { listAssistantCliTools, useExistingProviderForAssistantCli } from './assistant-cli-tools.js';

let homeDir = '';
let savedHome: string | undefined;

function authJson(home: string): string {
  return join(home, 'knowledge', 'secrets', 'auth.json');
}

function writeAuth(home: string, content: Record<string, unknown>): void {
  mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
  writeFileSync(authJson(home), `${JSON.stringify(content, null, 2)}\n`);
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-cli-tools-'));
  savedHome = process.env.OP_HOME;
  process.env.OP_HOME = homeDir;
  writeAuth(homeDir, {
    openai: { type: 'api', key: 'sk-openai-test' },
    anthropic: { type: 'api', key: 'sk-ant-test' },
    groq: { type: 'api', key: 'gsk-test' },
    github: { type: 'oauth', token: 'gho_test' },
  });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe('assistant CLI tool mappings', () => {
  it('reports tool config status and available provider mappings without secrets', () => {
    const tools = listAssistantCliTools(createState());
    const codex = tools.find((tool) => tool.id === 'codex');
    const pi = tools.find((tool) => tool.id === 'pi');
    const claude = tools.find((tool) => tool.id === 'claude');
    const copilot = tools.find((tool) => tool.id === 'copilot');

    expect(codex?.availableProviderMappings).toEqual([{ providerId: 'openai', label: 'OpenAI' }]);
    expect(pi?.availableProviderMappings).toEqual([
      { providerId: 'anthropic', label: 'Anthropic' },
      { providerId: 'openai', label: 'OpenAI' },
      { providerId: 'groq', label: 'Groq' },
    ]);
    expect(claude?.availableProviderMappings).toEqual([]);
    expect(copilot?.availableProviderMappings).toEqual([]);
    expect(JSON.stringify(tools)).not.toContain('sk-openai-test');
    expect(JSON.stringify(tools)).not.toContain('sk-ant-test');
  });

  it('writes codex auth.json and config.toml from the OpenAI provider', () => {
    const written = useExistingProviderForAssistantCli(createState(), 'codex', 'openai');
    const authPath = join(homeDir, 'data', 'assistant', '.codex', 'auth.json');
    const configPath = join(homeDir, 'data', 'assistant', '.codex', 'config.toml');

    expect(written).toEqual([authPath, configPath]);
    expect(JSON.parse(readFileSync(authPath, 'utf-8'))).toEqual({ OPENAI_API_KEY: 'sk-openai-test' });
    expect(readFileSync(configPath, 'utf-8')).toContain('preferred_auth_method = "apikey"');
  });

  it('preserves unrelated codex config when forcing apikey auth', () => {
    const configPath = join(homeDir, 'data', 'assistant', '.codex', 'config.toml');
    mkdirSync(join(homeDir, 'data', 'assistant', '.codex'), { recursive: true });
    writeFileSync(configPath, 'theme = "dark"\npreferred_auth_method = "chatgpt"\n');

    useExistingProviderForAssistantCli(createState(), 'codex', 'openai');

    expect(readFileSync(configPath, 'utf-8')).toBe('theme = "dark"\npreferred_auth_method = "apikey"\n');
  });

  it('writes pi auth.json and preserves unrelated providers', () => {
    const piPath = join(homeDir, 'data', 'assistant', '.pi', 'agent', 'auth.json');
    mkdirSync(join(homeDir, 'data', 'assistant', '.pi', 'agent'), { recursive: true });
    writeFileSync(piPath, `${JSON.stringify({ openrouter: { type: 'api_key', key: 'or-key' } }, null, 2)}\n`);

    const written = useExistingProviderForAssistantCli(createState(), 'pi', 'anthropic');

    expect(written).toEqual([piPath]);
    expect(JSON.parse(readFileSync(piPath, 'utf-8'))).toEqual({
      openrouter: { type: 'api_key', key: 'or-key' },
      anthropic: { type: 'api_key', key: 'sk-ant-test' },
    });
  });

  it('rejects unsupported direct mappings', () => {
    expect(() => useExistingProviderForAssistantCli(createState(), 'copilot', 'openai')).toThrow(
      'Direct provider mapping is not available for copilot',
    );
    expect(() => useExistingProviderForAssistantCli(createState(), 'codex', 'anthropic')).toThrow(
      'Codex only supports the OpenAI provider mapping',
    );
  });

  it('marks tools as configured when their on-disk config exists', () => {
    mkdirSync(join(homeDir, 'data', 'assistant', '.claude'), { recursive: true });
    mkdirSync(join(homeDir, 'data', 'assistant', '.copilot'), { recursive: true });
    writeFileSync(join(homeDir, 'data', 'assistant', '.claude', '.credentials.json'), '{}\n');
    writeFileSync(join(homeDir, 'data', 'assistant', '.copilot', 'config.json'), '{}\n');

    const tools = listAssistantCliTools(createState());

    expect(tools.find((tool) => tool.id === 'claude')?.configured).toBe(true);
    expect(tools.find((tool) => tool.id === 'copilot')?.configured).toBe(true);
    expect(existsSync(join(homeDir, 'data', 'assistant', '.claude', '.credentials.json'))).toBe(true);
  });
});
