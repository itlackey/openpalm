/**
 * Two-device LAN access — stack integration test.
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * This is the missing test called out in
 * `.github/roadmap/0.14.0/assessments/ui-lan-access-review.md` (Phase 3, item
 * 1): "nothing ever hit the published port from a NON-loopback source
 * address." Every serial LAN regression in this subsystem's history (the
 * review's confirmed findings #2-#5 — toggle saves that never applied, `/oc`
 * dropping auth, `/oc` chasing the wrong OpenCode, the 30s header timeout)
 * looked fine from loopback and broke only once a second device actually
 * dialed the network. This test drives that exact path end to end: enable
 * network access through the real admin API, resolve a genuine non-loopback
 * address for THIS machine, and hit the published port from it — login, an
 * `/oc` chat round trip, and `/voice` reachability.
 *
 * It deliberately targets the ASSISTANT CONTAINER's own UI co-process — the
 * copy `networkAccess` actually publishes
 * (`${OP_UI_BIND_ADDRESS}:${OP_UI_PORT:-3800}:3000` in core.compose.yml) —
 * NOT the host-admin UI every other `*.stack.ts` file drives via ADMIN_URL.
 * Those are the review's "two parallel UI serving paths" (§1): same chrome,
 * same login password, different capability, and — until this file — only
 * one of the two had ever been dialed from off-box.
 *
 * Does NOT send a real chat message (no model inference) — same scope as
 * chat-ui.stack.ts / opencode-ui.stack.ts's session-creation checks. The
 * thing under test is the LAN PATH (bind -> proxy -> upstream -> response
 * from a non-loopback source), not the LLM pipeline.
 */
import { expect, request as apiRequest, test } from '@playwright/test';
import { networkInterfaces } from 'node:os';
import {
  loginAndGetSessionCookie,
  loginBrowserContext,
  type SessionCookie,
} from './auth-helpers.js';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const UI_LOGIN_PASSWORD = process.env.OP_UI_LOGIN_PASSWORD ?? '';
// The container UI's PUBLISHED port (core.compose.yml:
// `${OP_UI_BIND_ADDRESS:-127.0.0.1}:${OP_UI_PORT:-3800}:3000`). Read live so
// this works both against the product default (3800) and an isolated
// launcher's offset port (dev-e2e-test.sh publishes the container UI on
// 3892 — see e2e/README.md's port table) — global-setup.ts already backfills
// OP_UI_PORT from stack.env into process.env.
const LAN_UI_PORT = process.env.OP_UI_PORT ?? '3800';

const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

/**
 * This machine's own LAN-facing IPv4 address — never 127.0.0.1/::1.
 *
 * Dialing the published port from the SAME machine's real network interface
 * (rather than loopback) is enough to prove the bind is not loopback-only:
 * that is the exact property every prior LAN regression got wrong, and a
 * second physical device adds nothing this assertion doesn't already cover.
 */
function resolveLanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

test.describe('Two-device LAN access', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');
  test.setTimeout(60_000);

  let lanUrl: string;
  let lanCookie: SessionCookie;

  test.beforeAll(async () => {
    const api = await apiRequest.newContext();
    try {
      // 1. Turn networkAccess ON through the same admin API the Assistant
      //    tab uses. Saving now APPLIES transactionally (applyAccessToggles,
      //    see commit 74277db): a successful PUT means the container has
      //    already been recreated with a widened bind, not just a promise a
      //    "restart to apply" button will keep later.
      const adminCookie = await loginAndGetSessionCookie(api, ADMIN_URL, UI_LOGIN_PASSWORD);
      const adminHeaders = {
        cookie: `${adminCookie.name}=${adminCookie.value}`,
        'x-requested-by': 'e2e-test',
        'x-request-id': crypto.randomUUID(),
        'content-type': 'application/json',
      };

      const current = await api.get(`${ADMIN_URL}/api/host/stack`, { headers: adminHeaders });
      if (!current.ok()) {
        throw new Error(`GET /api/host/stack failed: ${current.status()} ${await current.text()}`);
      }
      const { projectName } = await current.json();

      const put = await api.put(`${ADMIN_URL}/api/host/stack`, {
        headers: adminHeaders,
        data: { projectName, access: { networkAccess: true } },
      });
      if (!put.ok()) {
        throw new Error(`PUT /api/host/stack (networkAccess) failed: ${put.status()} ${await put.text()}`);
      }
      const applied = await put.json();
      if (applied.access?.networkAccess !== true) {
        throw new Error(`networkAccess did not apply: ${JSON.stringify(applied.access)}`);
      }

      // 2. Resolve a non-loopback address for THIS machine.
      const lanAddress = resolveLanAddress();
      if (!lanAddress) {
        throw new Error(
          'No non-loopback IPv4 interface found — the stack test launcher is expected to run on a host with a real network interface.',
        );
      }
      lanUrl = `http://${lanAddress}:${LAN_UI_PORT}`;

      // 3. Log into the LAN-published UI itself — a distinct origin/session
      //    from the admin login above; the container UI is non-admin and has
      //    its own /api/auth/login gate behind the same shared login
      //    password (the review's §1: "both present identical chrome and
      //    accept the same password"). Poll: applyAccessToggles just
      //    recreated the container, which needs a moment to clear its
      //    healthcheck before the new bind answers.
      await expect(async () => {
        lanCookie = await loginAndGetSessionCookie(api, lanUrl, UI_LOGIN_PASSWORD);
      }).toPass({ timeout: 30_000, intervals: [1_000, 2_000, 5_000] });
    } finally {
      await api.dispose();
    }
  });

  test('the container UI serves /chat from the LAN address, not just loopback', async ({ page, context }) => {
    await loginBrowserContext(page.request, context, lanUrl, UI_LOGIN_PASSWORD);
    await page.goto(`${lanUrl}/chat`, { waitUntil: 'domcontentloaded' });

    // The message input is always rendered (even with no sessions) — same
    // assertion chat-ui.stack.ts makes against the host-admin copy.
    await expect(page.locator('[aria-label="Message input"]')).toBeVisible({ timeout: 10_000 });
  });

  test('/oc chat round-trip works from a non-loopback source', async ({ request }) => {
    // Creating a session (no message, no model call) round-trips the whole
    // LAN path — browser -> published port -> /oc proxy -> assistant
    // OpenCode -> response — from a non-loopback source address, which is
    // exactly the leg that broke silently for findings #2-#5 in the review.
    const res = await request.post(`${lanUrl}/oc/session`, {
      headers: {
        cookie: `${lanCookie.name}=${lanCookie.value}`,
        'content-type': 'application/json',
        'x-request-id': crypto.randomUUID(),
      },
      data: { title: 'lan-e2e-session' },
    });
    expect(res.ok(), `POST /oc/session over LAN failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const session = await res.json();
    expect(session.id).toBeTruthy();
  });

  test('/voice is reachable (a handled response, not a dropped connection) over the LAN address', async ({
    request,
  }) => {
    // The container co-process's voice pass-through is documented as
    // unavailable BY DESIGN — the assistant container never joins addon_net,
    // where the voice service lives (AGENTS.md's Voice entry; the review's
    // §1 "voice hard-disabled" note on this copy). "Reachability" here means
    // the LAN path itself — bind, proxy, and route — is alive end to end: a
    // well-formed HTTP response (whatever its status), not ECONNREFUSED or a
    // hung socket, which is what the review's §3 describes shipping instead
    // ("LAN users silently have no voice").
    const res = await request.get(`${lanUrl}/voice/health`, {
      headers: {
        cookie: `${lanCookie.name}=${lanCookie.value}`,
        'x-request-id': crypto.randomUUID(),
      },
      timeout: 10_000,
    });
    expect(res.status(), '/voice must return a handled HTTP response over the LAN address').toBeLessThan(600);
  });
});
