/**
 * Shared Playwright helpers (G2/§12.2, review 2026-07-10) for driving the
 * real client UI against a stub assistant — every spec goes through the
 * actual /connections add form and the actual /chat SSE subscription rather
 * than poking IndexedDB directly, so these tests exercise the same code
 * paths a real user does.
 */
import { expect, type Page } from '@playwright/test';

/**
 * Adds one connection through the real /connections form (the client's only
 * connection-creation path) and returns once it's saved. A fresh Playwright
 * test gets a fresh browser context (fresh IndexedDB), so `/` always
 * redirects to `/connections/new` -> `/connections?new=1` with the add form
 * auto-opened (see src/routes/+page.ts's resolveLanding()).
 */
export async function addConnection(
  page: Page,
  url: string,
  label = 'Stub assistant',
  options: {
    kind?: 'remote-opencode' | 'openpalm-client-api';
    username?: string;
    password?: string;
  } = {}
): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/connections/);
  // The add-connection drawer auto-opens (see the doc comment above) — wait
  // for it rather than conditionally clicking "+ Add connection": that
  // button stays mounted (but scrim-covered) while the drawer is open
  // (G2/G3 fix, chat-round-trip's connections-form spec), so a racy
  // visibility check here could try to click it while it's still covered,
  // hanging on the scrim intercepting the click.
  const labelInput = page.getByLabel('Label');
  await expect(labelInput).toBeVisible();
  await labelInput.fill(label);
  if (options.kind) await page.getByLabel('Kind').selectOption(options.kind);
  await page.getByRole('textbox', { name: /^URL/ }).fill(url);
  if (options.password) {
    await page.getByLabel('Username (optional)').fill(options.username ?? 'opencode');
    await page.locator('input[type="password"]').fill(options.password);
  }
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
}

/**
 * Navigates to /chat and waits for the SSE `/event` subscription to
 * actually connect before returning — without this, a test that sends a
 * message immediately after `goto('/chat')` can race the stub assistant's
 * SSE push against chat-controller.ts's subscribeEvents() still being
 * mid-fetch, silently dropping the pushed deltas (the client wasn't
 * listening yet).
 */
export async function gotoConnectedChat(page: Page): Promise<void> {
  const eventStream = page.waitForResponse(
    (response) => response.url().endsWith('/event') && response.request().method() === 'GET'
  );
  await page.goto('/chat');
  await eventStream;
}
