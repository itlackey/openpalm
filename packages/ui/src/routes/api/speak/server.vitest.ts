import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
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
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  originalHome = process.env.OP_HOME;
  originalTtsBase = process.env.OP_TTS_BASE_URL;

  process.env.OP_HOME = makeTempDir();
  process.env.OP_TTS_BASE_URL = 'http://tts.local';
  resetState('admin-token');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  if (originalTtsBase === undefined) delete process.env.OP_TTS_BASE_URL;
  else process.env.OP_TTS_BASE_URL = originalTtsBase;
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  cleanupTempDirs();
  rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('POST /api/speak markdown stripping', () => {
  test('markdown is stripped before hitting the TTS endpoint', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      calls.push({ url: target, init });
      if (target === 'http://tts.local/v1/audio/speech') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      throw new Error(`Unexpected fetch ${target}`);
    });

    const res = await POST(makePostEvent({ text: '**Bold** reply with `code` and a [link](https://example.com).' }));
    expect(res.status).toBe(200);

    const ttsCall = calls.find((call) => call.url === 'http://tts.local/v1/audio/speech');
    expect(ttsCall).toBeDefined();
    const ttsBody = JSON.parse(String(ttsCall?.init?.body)) as Record<string, unknown>;
    expect(ttsBody.input).toBe('Bold reply with code and a link.');
  });

  test('legacy speech-prep fields are ignored — no LLM round trip, text still stripped', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      calls.push({ url: target, init });
      if (target === 'http://tts.local/v1/audio/speech') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      // Any OpenCode call (the removed speech-prep session flow) fails the test.
      throw new Error(`Unexpected fetch ${target}`);
    });

    const res = await POST(makePostEvent({
      text: '# Heading\n- one\n- two',
      mode: 'chat_reply',
      userText: 'Explain the plan.',
      assistantText: '# Heading\n- one\n- two',
    }));
    expect(res.status).toBe(200);

    expect(calls.map((call) => call.url)).toEqual(['http://tts.local/v1/audio/speech']);
    const ttsBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(ttsBody.input).toBe('Heading\none.\ntwo.');
  });
});
