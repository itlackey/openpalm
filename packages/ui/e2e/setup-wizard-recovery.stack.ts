/**
 * Setup wizard — host-dependent acceptance checks (#678).
 *
 * Collected by Playwright when RUN_DOCKER_STACK_TESTS=1 (*.stack.ts pattern).
 * Run via: ./scripts/dev-e2e-test.sh --skip-build --playwright
 *
 * These were filed as manual acceptance work. They are not manual — each one
 * needs a real host and a real stack, which tier 5 already provides, and none
 * of them needs a human. The half that needs neither (the install phase
 * sequence and its terminal states) is a unit test instead, in
 * lib/setup/setup-deploy-progress.vitest.ts, so it runs on every CI run.
 *
 * Covers:
 *   - System Check reports a port conflict, blocks Continue, and RECOVERS when
 *     the port is freed. Only the first half was ever verified by hand; the
 *     recovery half — the part an operator actually depends on — never was.
 *   - System Check probes the DEFAULT ports and ignores overrides sitting in
 *     state/stack.env. Defensible (the wizard writes ports at Review) but
 *     undocumented, and it cost real time to rediscover.
 *   - The provider catalog loads on a fresh wizard run with no deployed
 *     assistant, i.e. from the wizard's temporary OpenCode instance.
 *
 * The session-independence check from the same list lives in
 * auth-boundary.stack.ts: it is an auth-boundary property, not a wizard one,
 * and it needs a COMPLETED setup — running it beside these resets is what made
 * its login fail.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { resetWizardState, restoreWizardState, resolveOpHome } from './wizard-reset.ts';

const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:9100';
const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;

type PortRow = { port: number; service: string; available: boolean; blocking?: boolean };
type SystemCheck = { ports: PortRow[]; portCheckReliable: boolean };

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-request-id': crypto.randomUUID() };
}

async function systemCheck(request: APIRequestContext): Promise<SystemCheck> {
  const res = await request.get(`${ADMIN_URL}/api/setup/system-check`, { headers: headers() });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as SystemCheck;
}

test.describe('Setup wizard — System Check against a real host', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running dev stack');
  test.setTimeout(60_000);

  test.beforeAll(() => {
    resetWizardState(resolveOpHome());
  });

  test.afterAll(() => {
    restoreWizardState(resolveOpHome());
  });

  // What needs a real host is the PROBE. Whether a blocking conflict disables
  // Continue, and whether Retry clears it, is settled deterministically in
  // SystemCheckStep.svelte.vitest.ts — in the lane that runs every time,
  // rather than here, where it would depend on a required port happening to be
  // free and would otherwise skip. A skipped check is not a pass, and this
  // suite fails the run on any skip (no-skip-reporter.mjs).
  test('probes the required ports and reports each one bindable or not', async ({ request }) => {
    const check = await systemCheck(request);

    const services = check.ports.map((row) => row.service);
    expect(services).toEqual(expect.arrayContaining(['admin', 'ui', 'assistant']));
    for (const row of check.ports) {
      expect(Number.isInteger(row.port)).toBe(true);
      expect(row.port).toBeGreaterThan(0);
      expect(typeof row.available).toBe('boolean');
    }
  });

  // A port the running stack itself publishes must NOT read as a conflict —
  // otherwise every re-run of the wizard on a live host blocks on its own
  // containers. That is what portHeldByOurContainer exists for, and it only
  // means anything when Docker is reachable, which in this suite it is.
  test('a port held by our own containers is not reported as a conflict', async ({ request }) => {
    const check = await systemCheck(request);
    expect(check.portCheckReliable).toBe(true);

    const blockingConflicts = check.ports.filter((row) => !row.available && row.blocking);
    expect(
      blockingConflicts,
      `the running stack's own ports are being reported as conflicts: ${JSON.stringify(blockingConflicts)}`,
    ).toEqual([]);
  });

  // Encoding a surprise that cost real time: the probe reads the DEFAULT port
  // table, not overrides sitting in state/stack.env, because the wizard does
  // not write ports until Review. Anything configuring an isolated instance
  // must APPEND port rows — a fresh stack.env has none (#660), so a
  // sed-replace matches nothing and the stack silently binds the default.
  test('probes exactly the three required services, from the default table', async ({ request }) => {
    const check = await systemCheck(request);
    expect(check.ports.filter((row) => row.blocking).map((row) => row.service).sort()).toEqual([
      'admin',
      'assistant',
      'ui',
    ]);
  });
});

test.describe('Setup wizard — provider catalog without a deployed assistant', () => {
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running dev stack');
  test.setTimeout(120_000);

  test.beforeAll(() => {
    resetWizardState(resolveOpHome());
  });

  test.afterAll(() => {
    restoreWizardState(resolveOpHome());
  });

  test('the wizard can list providers before any assistant is deployed', async ({ request }) => {
    // ensureOpenCode is what stands up the wizard's temporary instance; the
    // catalog must come back from THAT, not from a deployed assistant.
    const ensure = await request.post(`${ADMIN_URL}/api/setup/opencode/ensure`, {
      headers: headers(),
      data: {},
    });
    expect(ensure.ok(), `temporary OpenCode instance did not come up (${ensure.status()})`).toBeTruthy();

    const res = await request.get(`${ADMIN_URL}/api/setup/opencode/providers`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // `available: false` is the shape returned when no OpenCode target
    // resolves at all — i.e. exactly the "fresh host, nothing deployed" case
    // this check exists to prove works. Surface its error rather than failing
    // on an opaque empty list.
    expect(body.available, `provider catalog unavailable: ${body.error ?? 'no error reported'}`).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.length).toBeGreaterThan(0);
  });
});
