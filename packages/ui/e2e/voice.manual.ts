/**
 * Voice addon — MANUAL smoke script (NOT an automated test).
 *
 * Named `.manual.ts` so Playwright's default `testMatch: '*.pw.ts'` skips
 * it. Run only when an operator explicitly invokes it against a live stack —
 * see e2e/README.md.
 *
 * Why manual? This script requires a live OpenPalm stack with the voice
 * container image available and a standalone UI server already listening on
 * ADMIN_URL. The route logic these checks cover (addon toggle + bring-up
 * orchestration) is already covered by the vitest suites in
 * src/routes/api/host/addons/server.vitest.ts with mocked docker. This file
 * is for pre-release smoke against the real stack.
 *
 * Voice architecture (see docs/technical/voice-settings-architecture.md):
 * the container lifecycle + hardware profile live under the Capabilities
 * addon API (`/api/host/addons`); the chat client reaches the container
 * through the same-origin `/voice/*` pass-through, so the synthesis check
 * below exercises exactly that path.
 *
 * Validates:
 *   - Auth gate on GET /api/host/addons
 *   - POST /api/auth/login (bad + good password)
 *   - GET /api/host/addons returns voice.profiles[] annotation (id +
 *     available + reason) and selectedProfile
 *   - POST /api/host/addons/voice with an unknown profile id → 400
 *   - POST /api/host/addons/voice {enabled:false} stops the container
 *   - POST /api/host/addons/voice {enabled:true, profile:…} starts it
 *     (200 healthy/warming, or 202 background pull)
 *   - Profile selection persists (selectedProfile round-trips)
 *   - POST /voice/v1/audio/speech (the same-origin pass-through the chat
 *     client uses) returns audio/wav; /voice/v1/models lists both models
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 \
 *     OP_UI_LOGIN_PASSWORD=<your-admin-password> \
 *     ADMIN_URL=http://127.0.0.1:8100 \
 *     bun run ui:test:e2e
 *
 * The default ADMIN_URL is 127.0.0.1:9100 (matches the test-isolated dev
 * stack). For a production stack on the default ports use 8100.
 *
 * NOTE: these tests mutate state/stack.state.env (OP_ENABLED_ADDONS,
 * OP_VOICE_PROFILE) and stop/start the openpalm-voice-* containers. Run only
 * against a dev stack you don't mind reconfiguring.
 */

import { expect, test } from '@playwright/test';
import { addonProfileId } from '@openpalm/lib';
import { execFileSync } from 'node:child_process';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const OP_UI_LOGIN_PASSWORD = process.env.OP_UI_LOGIN_PASSWORD ?? '';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
const VOICE_PROFILE_IDS = [
  addonProfileId('voice', 'cpu'),
  addonProfileId('voice', 'cuda'),
  addonProfileId('voice', 'rocm'),
];

function authHeaders(): Record<string, string> {
  return {
    cookie: `op_session=${OP_UI_LOGIN_PASSWORD}`,
    'x-requested-by': 'e2e-test',
    'x-request-id': crypto.randomUUID(),
    'content-type': 'application/json',
  };
}

/**
 * Probe docker for any container whose name starts with `openpalm-voice`.
 * Used as a black-box assertion that the toggle really stopped / started
 * the voice container. Returns the running container's name (e.g.
 * `openpalm-voice-cuda-1`) or null.
 */
function runningVoiceContainer(): string | null {
  try {
    const stdout = execFileSync(
      'docker',
      ['ps', '--filter', 'name=openpalm-voice', '--format', '{{.Names}}'],
      { encoding: 'utf-8', timeout: 5_000 },
    );
    const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    return lines[0] ?? null;
  } catch {
    return null;
  }
}

test.describe('Voice addon — auth gate', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('GET /api/host/addons unauthenticated → 401', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/addons`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/auth/login with wrong password → 401', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/api/auth/login`, {
      data: { password: 'definitely-not-the-password' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/auth/login with correct password → 200 + Set-Cookie op_session', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/api/auth/login`, {
      data: { password: OP_UI_LOGIN_PASSWORD },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const setCookie = res.headers()['set-cookie'] ?? '';
    expect(setCookie).toContain('op_session=');
  });
});

test.describe('Voice addon — GET /api/host/addons response shape', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('returns voice.profiles[] annotated with id/available/reason', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/addons`, { headers: authHeaders() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // Three canonical voice profiles.
    expect(body.voice.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: addonProfileId('voice', 'cpu') }),
        expect.objectContaining({ id: addonProfileId('voice', 'cuda') }),
        expect.objectContaining({ id: addonProfileId('voice', 'rocm') }),
      ]),
    );

    // Every profile carries the availability annotation fields.
    for (const profile of body.voice.profiles) {
      expect(typeof profile.available).toBe('boolean');
      if (profile.available === false) {
        expect(typeof profile.reason).toBe('string');
        expect(profile.reason.length).toBeGreaterThan(0);
      }
    }

    // ROCm should be unavailable on every non-AMD-ROCm host (which CI is)
    // with a friendly user-actionable reason.
    const rocm = body.voice.profiles.find((p: { id: string }) => p.id === addonProfileId('voice', 'rocm'));
    expect(rocm.available).toBe(false);
    expect(rocm.reason).toMatch(/AMD|ROCm|published|kfd/i);
  });

  test('exposes selectedProfile (null or a known id)', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/addons`, { headers: authHeaders() });
    const body = await res.json();
    const profileIds = body.voice.profiles.map((p: { id: string }) => p.id);
    expect(
      body.voice.selectedProfile === null
      || profileIds.includes(body.voice.selectedProfile),
    ).toBe(true);
  });
});

test.describe('Voice addon — toggle validation', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('unknown profile id → 400 invalid_profile', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/api/host/addons/voice`, {
      headers: authHeaders(),
      data: { enabled: true, profile: 'totally-fake' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_profile');
  });
});

test.describe('Voice addon — enable/disable lifecycle', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('enable with an explicit profile starts the container', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/api/host/addons/voice`, {
      headers: authHeaders(),
      data: { enabled: true, profile: addonProfileId('voice', 'cuda') },
    });
    // 200 = healthy or warming, 202 = background pull kicked off (first
    // ever launch on this host), 502 with steps = bring-up failure.
    expect([200, 202]).toContain(res.status());

    const body = await res.json();
    if (res.status() === 202) {
      // Background pull: just confirm the response shape and skip the
      // container assertion (it'll come up asynchronously, possibly
      // minutes later).
      expect(body.voiceAddon.status).toBe('pulling');
      return;
    }

    await new Promise((r) => setTimeout(r, 3_000));
    expect(runningVoiceContainer()).toMatch(/^openpalm-voice/);
  });

  test('profile selection persists (selectedProfile round-trips)', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/api/host/addons`, { headers: authHeaders() });
    const body = await res.json();
    expect(VOICE_PROFILE_IDS).toContain(body.voice.selectedProfile);
  });

  test('disable stops the running voice container', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/api/host/addons/voice`, {
      headers: authHeaders(),
      data: { enabled: false },
    });
    expect(res.status()).toBe(200);
    // Give compose-stop a moment to settle (it's a SIGTERM + grace).
    await new Promise((r) => setTimeout(r, 3_000));
    expect(runningVoiceContainer()).toBeNull();

    // Re-enable so the direct-synthesis suite below has a container.
    const up = await request.post(`${ADMIN_URL}/api/host/addons/voice`, {
      headers: authHeaders(),
      data: { enabled: true },
    });
    expect([200, 202]).toContain(up.status());
  });
});

test.describe('Voice pass-through — the path the chat client uses', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('POST /voice/v1/audio/speech → 200 + audio/wav RIFF header', async ({ request }) => {
    // The container needs a moment after start before /health returns 200
    // and TTS is loaded — bound the poll so a slow start doesn't flake.
    let res: Awaited<ReturnType<typeof request.post>> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      res = await request.post(`${ADMIN_URL}/voice/v1/audio/speech`, {
        headers: authHeaders(),
        data: { model: 'kokoro', input: 'hello from e2e', response_format: 'wav' },
      });
      if (res.status() === 200) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!res) throw new Error('voice pass-through never responded');
    expect(res.status()).toBe(200);

    const contentType = res.headers()['content-type'] ?? '';
    expect(contentType).toMatch(/audio\/wav/);

    const buf = await res.body();
    expect(buf.length).toBeGreaterThan(100);
    // RIFF header: 'RIFF' at byte 0, 'WAVE' at byte 8.
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });

  test('GET /voice/v1/models lists whisper-1 and kokoro', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/voice/v1/models`, { headers: authHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['whisper-1', 'kokoro']));
  });

  test('POST /voice/v1/audio/speech unauthenticated → 401', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/voice/v1/audio/speech`, {
      headers: { 'content-type': 'application/json', 'x-request-id': crypto.randomUUID() },
      data: { model: 'kokoro', input: 'hello' },
    });
    expect(res.status()).toBe(401);
  });
});
