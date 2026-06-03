/**
 * Voice addon — MANUAL smoke script (NOT an automated test).
 *
 * Renamed to `.manual.ts` so Playwright's default `testMatch: '*.pw.ts'`
 * skips it. Run only when an operator explicitly invokes it against a
 * live stack — see e2e/README.md.
 *
 * Why manual? This script requires a live OpenPalm stack with the voice
 * container running and a standalone UI server already listening on
 * ADMIN_URL. The route logic these checks cover (compose orchestration,
 * error translation, OP_TTS_* env resolution, /api/speak proxy behavior)
 * is already covered by the vitest suites in
 * src/routes/admin/voice/server.vitest.ts and
 * src/routes/api/transcribe/server.vitest.ts with mocked docker. This
 * file is for pre-release smoke against the real stack.
 *
 * Originally written as automated e2e (voice.pw.ts) — reclassified
 * after the realisation that "tests that need a production stack" are
 * not tests, they're scripted manual QA.
 *
 * Validates the full happy-path of OpenPalm Voice (Kokoro TTS + Whisper STT
 * via the openpalm/voice container) plus error / edge paths:
 *
 *   - Auth gate on GET /admin/voice
 *   - POST /admin/auth/login (bad + good password)
 *   - GET /admin/voice returns the new addon.profiles[] annotation (id +
 *     available + reason)
 *   - PUT /admin/voice validation (missing baseURL, unknown profile id)
 *   - PUT engine=browser stops the running voice container (auto-stop)
 *   - PUT engine=openpalm-voice + profile=addon.voice.cuda brings the container back up
 *   - POST /api/speak with text returns audio/wav
 *   - POST /api/speak with empty text returns 400
 *   - Profile selection persists to stack.env
 *
 * Background:
 *   These tests mirror an 11-step manual pass driven by curl against the
 *   running dev (or production) stack. Each `test(...)` block below
 *   corresponds 1:1 to a manual step so a developer can run either form
 *   to verify the same behavior.
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
 * NOTE: these tests mutate stack.env (OP_TTS_*, OP_STT_*, OP_VOICE_PROFILE)
 * and stop/start the openpalm-voice-* containers. Run only against a dev
 * stack you don't mind reconfiguring.
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
 * Used as a black-box assertion that the route really stopped / started
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

/**
 * Ensure a voice container is running before a test that depends on it.
 * Best-effort — relies on the previous suite step having configured
 * engine=openpalm-voice + a valid profile. Skips silently if no
 * container is present (the test that needs it will then fail its own
 * assertions with a clearer signal).
 */
function ensureVoiceUp(): void {
  if (runningVoiceContainer()) return;
  try {
    execFileSync('docker', ['start', 'openpalm-voice-cuda-1'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
  } catch {
    /* no-op — let downstream assertions surface the failure */
  }
}

test.describe('Voice addon — auth gate', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('GET /admin/voice unauthenticated → 401', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/voice`, {
      headers: { 'x-request-id': crypto.randomUUID() },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /admin/auth/login with wrong password → 401', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/admin/auth/login`, {
      data: { password: 'definitely-not-the-password' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /admin/auth/login with correct password → 200 + Set-Cookie op_session', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/admin/auth/login`, {
      data: { password: OP_UI_LOGIN_PASSWORD },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const setCookie = res.headers()['set-cookie'] ?? '';
    expect(setCookie).toContain('op_session=');
  });
});

test.describe('Voice addon — GET /admin/voice response shape', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('returns addon.profiles[] annotated with id/available/reason', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/voice`, { headers: authHeaders() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // Three canonical voice profiles.
    expect(body.addon.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: addonProfileId('voice', 'cpu') }),
        expect.objectContaining({ id: addonProfileId('voice', 'cuda') }),
        expect.objectContaining({ id: addonProfileId('voice', 'rocm') }),
      ]),
    );

    // Every profile carries the new annotation fields (round-2 fix).
    for (const profile of body.addon.profiles) {
      expect(typeof profile.available).toBe('boolean');
      if (profile.available === false) {
        expect(typeof profile.reason).toBe('string');
        expect(profile.reason.length).toBeGreaterThan(0);
      }
    }

    // ROCm should be unavailable on every non-AMD-ROCm host (which CI is)
    // with a friendly user-actionable reason.
    const rocm = body.addon.profiles.find((p: { id: string }) => p.id === addonProfileId('voice', 'rocm'));
    expect(rocm.available).toBe(false);
    expect(rocm.reason).toMatch(/AMD|ROCm|published|kfd/i);
  });

  test('exposes selectedProfile (null or a known id)', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/voice`, { headers: authHeaders() });
    const body = await res.json();
    const profileIds = body.addon.profiles.map((p: { id: string }) => p.id);
    expect(
      body.addon.selectedProfile === null
      || profileIds.includes(body.addon.selectedProfile),
    ).toBe(true);
  });
});

test.describe('Voice addon — PUT validation', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('engine=remote without baseURL → 400 invalid_stt', async ({ request }) => {
    const res = await request.put(`${ADMIN_URL}/admin/voice`, {
      headers: authHeaders(),
      data: { stt: { engine: 'remote', model: 'whisper-1' } },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_stt');
    expect(body.message).toMatch(/endpoint URL/i);
  });

  test('unknown profile id → 400 invalid_profile with actionable list', async ({ request }) => {
    const res = await request.put(`${ADMIN_URL}/admin/voice`, {
      headers: authHeaders(),
      data: {
        tts: { engine: 'openpalm-voice' },
        stt: { engine: 'openpalm-voice' },
        profile: 'totally-fake',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_profile');
    // Lists the real available ids so the operator can pick a valid one.
    expect(body.message).toMatch(/cpu/);
    expect(body.message).toMatch(/cuda/);
  });
});

test.describe('Voice addon — engine switch lifecycle', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('switching to engine=browser stops the running voice container', async ({ request }) => {
    // Setup: bring up the voice container in whatever state the previous
    // test left it (or skip if Docker can't find it).
    ensureVoiceUp();
    expect(runningVoiceContainer()).toMatch(/^openpalm-voice/);

    const res = await request.put(`${ADMIN_URL}/admin/voice`, {
      headers: authHeaders(),
      data: {
        tts: { enabled: true, engine: 'browser' },
        stt: { enabled: true, engine: 'browser' },
      },
    });
    expect(res.status()).toBe(200);
    // Give compose-stop a moment to settle (it's a SIGTERM + grace).
    await new Promise((r) => setTimeout(r, 3_000));
    expect(runningVoiceContainer()).toBeNull();
  });

  test('switching back to engine=openpalm-voice with profile=addon.voice.cuda starts the container', async ({ request }) => {
    const res = await request.put(`${ADMIN_URL}/admin/voice`, {
      headers: authHeaders(),
      data: {
        tts: { enabled: true, engine: 'openpalm-voice' },
        stt: { enabled: true, engine: 'openpalm-voice' },
        profile: addonProfileId('voice', 'cuda'),
      },
    });
    // 200 = healthy or warming, 202 = background pull kicked off (first
    // ever launch on this host). Either is acceptable here.
    expect([200, 202]).toContain(res.status());

    const body = await res.json();
    if (res.status() === 202) {
      // Background pull: just confirm the response shape and skip the
      // container assertion (it'll come up asynchronously, possibly
      // minutes later).
      expect(body.voiceAddon.status).toBe('pulling');
      return;
    }

    // 200 path: container should be present (may still be in "starting"
    // state for first ~3s; the route's health-poll either confirmed
    // healthy or surfaced warming=true).
    await new Promise((r) => setTimeout(r, 3_000));
    expect(runningVoiceContainer()).toMatch(/^openpalm-voice/);
  });

  test('GET /admin/voice after save persists OP_VOICE_PROFILE', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/voice`, { headers: authHeaders() });
    const body = await res.json();
    // Whatever profile we just saved (addon.voice.cuda from the previous test) should
    // come back as the selectedProfile.
    expect(VOICE_PROFILE_IDS).toContain(body.addon.selectedProfile);
  });
});

test.describe('Voice addon — /api/speak proxy', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('POST /api/speak with text → 200 + audio/wav RIFF header', async ({ request }) => {
    ensureVoiceUp();
    // The container needs a moment after start before /health returns 200
    // and TTS is loaded — bound the poll so a slow start doesn't flake.
    let res: Awaited<ReturnType<typeof request.post>> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      res = await request.post(`${ADMIN_URL}/api/speak`, {
        headers: authHeaders(),
        data: { text: 'hello from e2e' },
      });
      if (res.status() === 200) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!res) throw new Error('/api/speak never responded');
    expect(res.status()).toBe(200);

    const contentType = res.headers()['content-type'] ?? '';
    expect(contentType).toMatch(/audio\/wav/);

    const buf = await res.body();
    expect(buf.length).toBeGreaterThan(100);
    // RIFF header: 'RIFF' at byte 0, 'WAVE' at byte 8.
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });

  test('POST /api/speak with empty text → 400 bad_request', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/api/speak`, {
      headers: authHeaders(),
      data: { text: '' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('bad_request');
    expect(body.message).toMatch(/text/i);
  });

  test('POST /api/speak unauthenticated → 401', async ({ request }) => {
    const res = await request.post(`${ADMIN_URL}/api/speak`, {
      headers: { 'content-type': 'application/json', 'x-request-id': crypto.randomUUID() },
      data: { text: 'hello' },
    });
    expect(res.status()).toBe(401);
  });
});
