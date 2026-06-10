import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { POST } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-speak-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makePostEvent(body: unknown, token = 'admin-token'): Parameters<typeof POST>[0] {
  return {
    request: new Request('http://localhost/api/speak', {
      method: 'POST',
      headers: {
        cookie: `op_session=${token}`,
        'x-request-id': 'req-speak',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

let originalHome: string | undefined;
let originalTtsBase: string | undefined;
let originalOpencodeUrl: string | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  originalHome = process.env.OP_HOME;
  originalTtsBase = process.env.OP_TTS_BASE_URL;
  originalOpencodeUrl = process.env.OP_OPENCODE_URL;

  process.env.OP_HOME = makeTempDir();
  process.env.OP_TTS_BASE_URL = 'http://tts.local';
  process.env.OP_OPENCODE_URL = 'http://assistant.local';
  resetState('admin-token');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  if (originalTtsBase === undefined) delete process.env.OP_TTS_BASE_URL;
  else process.env.OP_TTS_BASE_URL = originalTtsBase;
  if (originalOpencodeUrl === undefined) delete process.env.OP_OPENCODE_URL;
  else process.env.OP_OPENCODE_URL = originalOpencodeUrl;
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  cleanupTempDirs();
  rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('POST /api/speak speech prep', () => {
  test('uses the small model plus persona to generate a working-on-it acknowledgement', async () => {
    mkdirSync(join(getState().configDir, 'assistant'), { recursive: true });
    writeFileSync(join(getState().configDir, 'assistant', 'openpalm.md'), 'Be warm and relaxed.\n');
    writeFileSync(
      join(getState().configDir, 'assistant', 'opencode.json'),
      JSON.stringify({ small_model: 'openai/gpt-4.1-mini', model: 'openai/gpt-4.1' }) + '\n',
    );

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      calls.push({ url: target, init });
      if (target === 'http://assistant.local/config') {
        return new Response(JSON.stringify({ small_model: 'openai/gpt-4.1-mini', model: 'openai/gpt-4.1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === 'http://assistant.local/session') {
        return new Response(JSON.stringify({ id: 'prep-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === 'http://assistant.local/session/prep-1/message') {
        return new Response(JSON.stringify({ parts: [{ type: 'text', text: 'Sure, I am on it.' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === 'http://assistant.local/session/prep-1') {
        return new Response(null, { status: 204 });
      }
      if (target === 'http://tts.local/v1/audio/speech') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      throw new Error(`Unexpected fetch ${target}`);
    });

    const res = await POST(makePostEvent({ text: 'Working on it.', mode: 'chat_ack', userText: 'Write a poem.' }));
    expect(res.status).toBe(200);

    const messageCall = calls.find((call) => call.url.endsWith('/session/prep-1/message'));
    expect(messageCall).toBeDefined();
    const messageBody = JSON.parse(String(messageCall?.init?.body)) as Record<string, unknown>;
    expect(messageBody.model).toBe('openai/gpt-4.1-mini');
    expect(JSON.stringify(messageBody.parts)).toContain('Be warm and relaxed.');
    expect(JSON.stringify(messageBody.parts)).toContain('Write a poem.');

    const ttsCall = calls.find((call) => call.url === 'http://tts.local/v1/audio/speech');
    expect(ttsCall).toBeDefined();
    const ttsBody = JSON.parse(String(ttsCall?.init?.body)) as Record<string, unknown>;
    expect(ttsBody.input).toBe('Sure, I am on it.');
  });

  test('falls back to the main chat model for final reply summaries', async () => {
    mkdirSync(join(getState().configDir, 'assistant'), { recursive: true });
    writeFileSync(join(getState().configDir, 'assistant', 'openpalm.md'), 'Be crisp and friendly.\n');
    writeFileSync(
      join(getState().configDir, 'assistant', 'opencode.json'),
      JSON.stringify({ model: 'openai/gpt-4.1' }) + '\n',
    );

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      calls.push({ url: target, init });
      if (target === 'http://assistant.local/config') {
        return new Response(JSON.stringify({ model: 'openai/gpt-4.1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === 'http://assistant.local/session') {
        return new Response(JSON.stringify({ id: 'prep-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === 'http://assistant.local/session/prep-2/message') {
        return new Response(JSON.stringify({ parts: [{ type: 'text', text: 'Here is the short spoken version.' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === 'http://assistant.local/session/prep-2') {
        return new Response(null, { status: 204 });
      }
      if (target === 'http://tts.local/v1/audio/speech') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      throw new Error(`Unexpected fetch ${target}`);
    });

    const res = await POST(makePostEvent({
      text: 'Full agent answer.',
      mode: 'chat_reply',
      userText: 'Explain the plan.',
      assistantText: 'Full agent answer.',
    }));
    expect(res.status).toBe(200);

    const messageCall = calls.find((call) => call.url.endsWith('/session/prep-2/message'));
    expect(messageCall).toBeDefined();
    const messageBody = JSON.parse(String(messageCall?.init?.body)) as Record<string, unknown>;
    expect(messageBody.model).toBe('openai/gpt-4.1');
    expect(JSON.stringify(messageBody.parts)).toContain('Explain the plan.');
    expect(JSON.stringify(messageBody.parts)).toContain('Full agent answer.');
  });
});
