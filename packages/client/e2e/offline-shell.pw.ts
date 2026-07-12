/**
 * #511 T11 — offline end-to-end verification (Playwright). Drives the real
 * built client (bin/serve.mjs, playwright.config.ts's webServer) through a
 * genuine offline reload/navigation, proving the PWA shell + IndexedDB
 * connection store survive with no live network — the acceptance criterion
 * "Offline: shell + saved connections render; SW never caches credentialed
 * responses".
 *
 * Idiom: e2e/fixtures/client-app.ts addConnection() (drives the real
 * /connections add form, not direct IndexedDB pokes) + a stub assistant so
 * the "online" half of each test has something real to save.
 *
 * HONESTY NOTE (mandated framing, spec §2 T11): this is a *verification pin*
 * of an acceptance criterion whose plumbing (SW registration + Workbox
 * precache + IndexedDB connection store) already shipped on this branch
 * (pwa-config.test.ts, connections-store.test.ts, boot.test.ts) — unlike
 * T1–T10, it may therefore PASS at the red/commit stage rather than fail.
 * Commit it in the tests-first stage regardless (precedent: #486
 * remote-attach.e2e.test.ts, 24/28 passing at its own red stage) and record
 * the observed status in the commit message.
 *
 * OBSERVED (this dev-container sandbox, chromium via Playwright): both tests
 * FAIL with `net::ERR_INTERNET_DISCONNECTED`, even though direct diagnostics
 * confirm the product is correct — `navigator.serviceWorker.controller` is
 * set immediately (clientsClaim), and Cache Storage is fully populated and
 * readable (`caches.open(...).keys()` returns all 27 precached entries)
 * while `context.setOffline(true)` is active. The failure is that Chromium
 * never dispatches the page's `fetch`/navigation to the Service Worker's
 * `fetch` handler at all once `context.setOffline(true)` is set — a documented
 * limitation of Playwright/Puppeteer's CDP-driven `Network.emulateNetworkConditions`
 * offline emulation, which cuts the network below the Service Worker
 * interception point (unlike a real device's airplane mode, where the SW
 * still intercepts and serves entirely from Cache Storage with no network
 * involved). This is a test-harness/browser-automation limitation, not a
 * product gap — do not "fix" the SW to satisfy it. The enforcing gate for
 * this acceptance criterion is a real offline test on an actual device/PWA
 * install, or CI's client-browser-tests job (ci.yml:355) if its runner
 * exhibits different CDP offline behavior; say so in the PR-stage report.
 */
import { expect, test } from '@playwright/test';
import { addConnection } from './fixtures/client-app.js';
import { startStubAssistant, type StubAssistant } from './fixtures/stub-assistant.js';

let assistant: StubAssistant | undefined;

test.afterEach(async () => {
  await assistant?.close();
  assistant = undefined;
});

test('offline reload renders the app shell and saved connections from IndexedDB (no blank page)', async ({
  page,
  context,
}) => {
  assistant = await startStubAssistant();
  await addConnection(page, assistant.url, 'Offline pin');

  // Wait for the service worker to actually control this page before going
  // offline — a reload before that point would just hit the dev/prod server
  // directly (still online) and prove nothing about offline behavior.
  await page.evaluate(() => navigator.serviceWorker.ready);

  // One more online reload so the now-registered SW takes control of THIS
  // page (a page loaded before its own SW finishes registering is not yet
  // controlled — Workbox/clients.claim() semantics). `page.reload()` already
  // waits for the 'load' event; 'networkidle' is deliberately avoided here —
  // the chat page's persistent SSE connection can keep the network from
  // ever going idle.
  await page.reload();

  await context.setOffline(true);
  await page.reload();

  // Shell chrome renders (the persistent nav landmark from +layout.svelte).
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  // The saved connection, read back from IndexedDB with no network involved.
  await page.goto('/connections');
  await expect(page.getByText('Offline pin', { exact: true }).first()).toBeVisible();

  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText.trim().length).toBeGreaterThan(0);
});

test('offline navigation is served by the SW navigateFallback (deep link, then chat shows an error state, not a crash)', async ({
  page,
  context,
}) => {
  assistant = await startStubAssistant();
  await addConnection(page, assistant.url, 'Offline chat pin');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();

  await context.setOffline(true);

  // A deep link straight to /chat while offline must be served by the SW's
  // navigateFallback (precached index.html + client-side router), not fail
  // at the network layer.
  const response = await page.goto('/chat');
  expect(response, 'the SW navigateFallback must serve this navigation').not.toBeNull();

  // Shell chrome renders even though the assistant connection is
  // unreachable offline — this is a reachability/error state, not a blank
  // page or an uncaught crash.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText.trim().length).toBeGreaterThan(0);
});
