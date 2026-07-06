/**
 * Setup guard + wizard handoff — self-contained Playwright contract test
 * (mocked-lib subset, 3.4).
 *
 * Runs against the isolated, throwaway OP_HOME configured in
 * playwright.config.ts (no OP_SETUP_COMPLETE marker exists there, so
 * hooks.server.ts's launch-routing guard always treats this as a fresh
 * instance). This must stay independent of the running *host's* network
 * state: hooks.server.ts's recommendedRoute also depends on whether a
 * configured "default" remote endpoint happens to be reachable, which is
 * outside OP_HOME's control — so the redirect target here is asserted
 * loosely (any of the guard's known landing pages), not an exact path.
 *
 * The wizard-handoff assertion deliberately stops at "the /setup page loads"
 * — the wizard's first visible step only renders once a real Docker daemon
 * passes its check (SystemCheckStep.svelte auto-advances on
 * `docker.ok && compose.ok`, see runChecks()), which the mocked subset must
 * not depend on. That deeper walk-through is covered by
 * install-flow.stack.ts against a live stack.
 */
import { test, expect } from '@playwright/test';

test.describe('Setup guard — fresh instance (mocked-lib)', () => {
  test('GET / never serves raw admin/chat content unauthenticated', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.status()).toBeLessThan(400);
    // Whatever the guard's recommended landing page is (splash, setup, or a
    // bounce through chat straight to the login gate), it must be one of
    // these — never a bare admin page rendered with no session.
    await expect(page).toHaveURL(/\/(splash|setup|login)/);
  });

  test('GET /setup is directly reachable, unauthenticated, from localhost', async ({ page }) => {
    const res = await page.goto('/setup');
    expect(res?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/setup/);
  });
});

test.describe('Wizard handoff (mocked-lib)', () => {
  test('setup wizard page loads (does not error, does not bounce away)', async ({ page }) => {
    const res = await page.goto('/setup');
    expect(res?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/setup/);
    await expect(page).toHaveTitle('OpenPalm Setup');
  });
});
