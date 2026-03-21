import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { getState, resetState } from '$lib/server/state.js';
import { POST } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-assignments-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedStackYaml(): void {
  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  writeFileSync(join(state.configDir, 'stack.yaml'), yamlStringify({
    version: 2,
    capabilities: {
      llm: 'openai/gpt-4o',
      embeddings: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dims: 1536,
      },
      memory: {
        userId: 'default_user',
      },
    },
    addons: {},
  }));
}

function makeEvent(body: unknown, token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/admin/connections/assignments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': token,
        'x-request-id': 'req-assignments',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
  seedStackYaml();
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('/admin/connections/assignments route', () => {
  test('requires admin token', async () => {
    const res = await POST(makeEvent({ llm: 'openai/gpt-4.1-mini' }, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('rejects malformed capability payloads', async () => {
    const res = await POST(makeEvent({
      capabilities: {
        embeddings: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          dims: '1536',
        },
      },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('embeddings.dims must be a positive integer');
  });

  test('rejects unsupported capability keys', async () => {
    const res = await POST(makeEvent({
      capabilities: {
        llm: 'openai/gpt-4.1-mini',
        unexpected: true,
      },
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('unsupported key "unexpected"');
  });

  test('persists validated assignments and regenerates managed env', async () => {
    const res = await POST(makeEvent({
      capabilities: {
        llm: 'anthropic/claude-sonnet-4',
        embeddings: {
          provider: 'google',
          model: 'text-embedding-004',
          dims: 768,
        },
        memory: {
          userId: 'owner',
          customInstructions: 'Keep it concise.',
        },
      },
    }));

    expect(res.status).toBe(200);

    const state = getState();
    const spec = yamlParse(readFileSync(join(state.configDir, 'stack.yaml'), 'utf-8')) as {
      capabilities: {
        llm: string;
        embeddings: { provider: string; model: string; dims: number };
        memory: { userId: string; customInstructions?: string };
      };
    };
    expect(spec.capabilities.llm).toBe('anthropic/claude-sonnet-4');
    expect(spec.capabilities.embeddings).toEqual({
      provider: 'google',
      model: 'text-embedding-004',
      dims: 768,
    });
    expect(spec.capabilities.memory).toEqual({
      userId: 'owner',
      customInstructions: 'Keep it concise.',
    });

    const managedEnv = readFileSync(join(state.vaultDir, 'stack', 'services', 'memory', 'managed.env'), 'utf-8');
    expect(managedEnv).toContain('SYSTEM_LLM_PROVIDER=anthropic');
    expect(managedEnv).toContain('EMBEDDING_MODEL=text-embedding-004');
  });
});
