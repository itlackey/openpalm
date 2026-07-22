import { expect, test, chromium } from '@playwright/test';
import type { Browser, BrowserContext, CDPSession, Locator, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UI_PORT = process.env.OP_PWA_UI_PORT ?? '4174';
const FIXTURE_PORT = process.env.OP_PWA_FIXTURE_PORT ?? '4175';
const UI_ORIGIN = `http://localhost:${UI_PORT}`;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const SECONDARY_FIXTURE_ORIGIN = `${FIXTURE_ORIGIN}/secondary`;
const FIXTURE_USERNAME = 'pwa-user';
const FIXTURE_PASSWORD = 'pwa-secret-password';

type Cdp = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

type CacheSnapshot = {
  names: string[];
  urls: string[];
};

type StoredConnection = {
  id: string;
  label: string;
  baseUrl: string;
  auth: { mode: string; username?: string; secretRef?: string };
};

type IndexedDbSnapshot = {
  connections: StoredConnection[];
  activeId: string | null;
  meta: Array<{ key: string; value: string }>;
};

type FixtureState = {
  authorizedRequests: number;
  rejectedAuth: number;
  eventConnections: number;
  eventClosed: number;
  messagePosts: number;
  activeEventStreams: number;
  sessions: number;
  messages: number;
};

async function cdpSend<T>(session: CDPSession, method: string, params?: Record<string, unknown>): Promise<T> {
  return (await (session as unknown as Cdp).send(method, params)) as T;
}

async function waitForServiceWorker(page: Page): Promise<{ scriptURL: string; controlled: boolean }> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      });
    }
    return {
      scriptURL: registration.active?.scriptURL ?? '',
      controlled: navigator.serviceWorker.controller !== null,
    };
  });
}

async function cacheSnapshot(page: Page): Promise<CacheSnapshot> {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const urls = (
      await Promise.all(
        names.map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)),
      )
    ).flat();
    return { names, urls };
  });
}

async function indexedDbSnapshot(page: Page): Promise<IndexedDbSnapshot> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('openpalm-ui-connections');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction(['connections', 'meta'], 'readonly');
          const connectionsRequest = transaction.objectStore('connections').getAll();
          const activeRequest = transaction.objectStore('meta').get('activeId');
          const metaKeysRequest = transaction.objectStore('meta').getAllKeys();
          const metaValuesRequest = transaction.objectStore('meta').getAll();
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => {
            const keys = metaKeysRequest.result.map(String);
            const values = metaValuesRequest.result;
            resolve({
              connections: connectionsRequest.result
                .map((entry) => ({ id: entry.id, label: entry.label, baseUrl: entry.baseUrl, auth: entry.auth }))
                .sort((a, b) => a.label.localeCompare(b.label)),
              activeId: typeof activeRequest.result === 'string' ? activeRequest.result : null,
              meta: keys.flatMap((key, index) =>
                typeof values[index] === 'string' ? [{ key, value: values[index] }] : [],
              ),
            });
            db.close();
          };
        };
      }),
  );
}

async function fixtureState(): Promise<FixtureState> {
  const response = await fetch(`${FIXTURE_ORIGIN}/__test/state`);
  if (!response.ok) throw new Error(`Fixture state failed: HTTP ${response.status}`);
  return response.json() as Promise<FixtureState>;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a CDP port');
  const { port } = address;
  server.close();
  await once(server, 'close');
  return port;
}

function processRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function stopChromiumProcess(child: ChildProcess): Promise<void> {
  if (!processRunning(child)) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 2_000)),
  ]);
  if (timedOut && processRunning(child)) child.kill('SIGKILL');
  await exited;
}

async function removeProfile(profile: string): Promise<void> {
  const retryable = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !retryable.has(code) || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function launchChromium(
  profile: string,
  executablePath: string,
  standalone: boolean,
): Promise<{ browser: Browser; context: BrowserContext; page: Page; process: ChildProcess }> {
  const cdpPort = await availablePort();
  const process = spawn(
    executablePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      ...(standalone ? [`--app=${UI_ORIGIN}/chat`] : ['about:blank']),
    ],
    { stdio: 'ignore' },
  );

  let browser: Browser | undefined;
  for (let attempt = 0; attempt < 50 && process.exitCode === null; attempt += 1) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!browser) {
    await stopChromiumProcess(process);
    throw new Error('Could not attach Playwright to Chromium');
  }

  const context = browser.contexts()[0];
  if (!context) {
    await closeChromium(browser, process);
    throw new Error('Chromium did not create a browser context');
  }
  let page = context.pages()[0];
  for (let attempt = 0; !page && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    page = context.pages()[0];
  }
  if (!page) {
    await closeChromium(browser, process);
    throw new Error('Chromium did not open a page');
  }
  return { browser, context, page, process };
}

async function closeChromium(browser: Browser, child: ChildProcess): Promise<void> {
  const closed = browser.close().catch(() => {});
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  await stopChromiumProcess(child);
  await closed;
}

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${FIXTURE_ORIGIN}/__test/reset`);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ sessions: 0, messages: 0, activeEventStreams: 0 });
});

test('production client-only PWA is installable, persists its connection, chats, and caches only its shell', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'openpalm-pwa-chromium-'));
  const executablePath = process.env.OP_PLAYWRIGHT_EXECUTABLE_PATH?.trim() || chromium.executablePath();
  let context: BrowserContext | undefined;
  let browser: Browser | undefined;
  let chromiumProcess: ChildProcess | undefined;
  let cdp: CDPSession | undefined;
  let bodyError: unknown;

  try {
    const initial = await launchChromium(profile, executablePath, false);
    browser = initial.browser;
    chromiumProcess = initial.process;
    context = initial.context;
    const page = initial.page;
    const navigationUrls: string[] = [];
    const fixtureRequests: Array<{ method: string; url: string }> = [];
    const fixtureEventContentTypes: string[] = [];
    context.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigationUrls.push(request.url());
      }
      if (request.url().startsWith(FIXTURE_ORIGIN)) {
        fixtureRequests.push({ method: request.method(), url: request.url() });
      }
    });
    context.on('response', (response) => {
      if (response.ok() && response.url().endsWith('/event')) {
        fixtureEventContentTypes.push(response.headers()['content-type'] ?? '');
      }
    });

    await test.step('fresh client-only launch reaches the real add-connection flow', async () => {
      const runtimeConfig = await context.request.get(`${UI_ORIGIN}/api/runtime-config`);
      expect(runtimeConfig.status()).toBe(200);
      expect(await runtimeConfig.json()).toEqual({ connections: [] });

      const host = await context.request.get(`${UI_ORIGIN}/host`, {
        headers: { accept: 'text/html' },
        maxRedirects: 0,
      });
      expect(host.status()).toBe(302);
      expect(host.headers().location).toBe('/chat');

      await page.goto(UI_ORIGIN, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(`${UI_ORIGIN}/connections?new=1`);
      expect(navigationUrls).toContain(`${UI_ORIGIN}/connections/new`);
      await expect(page.getByRole('heading', { name: 'Add connection' })).toBeVisible();

      const runtime = await page.evaluate(async () => {
        const response = await fetch('/api/runtime');
        return response.json();
      });
      expect(runtime).toMatchObject({
        admin: false,
        publicBaseUrl: UI_ORIGIN,
        routes: { chat: '/chat', connections: '/connections' },
      });
      expect(runtime.serverCapabilities).toContain('pwa:install');
      expect(runtime.serverCapabilities.some((capability: string) => capability.startsWith('host:'))).toBe(false);
      expect(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(false);

      const hostApi = await page.evaluate(async () => {
        const response = await fetch('/api/host/health', { cache: 'no-store' });
        return { status: response.status, body: await response.json() };
      });
      expect(hostApi).toMatchObject({
        status: 403,
        body: {
          error: 'capability_not_available',
          details: { capability: 'host:stack:read', admin: false },
        },
      });

      const authStatuses = await page.evaluate(
        async ({ fixtureOrigin, wrongAuthorization }) => {
          const [missing, wrong] = await Promise.all([
            fetch(`${fixtureOrigin}/session`, { cache: 'no-store' }),
            fetch(`${fixtureOrigin}/session`, {
              cache: 'no-store',
              headers: { authorization: wrongAuthorization },
            }),
          ]);
          return [missing.status, wrong.status];
        },
        {
          fixtureOrigin: FIXTURE_ORIGIN,
          wrongAuthorization: `Basic ${Buffer.from(`${FIXTURE_USERNAME}:wrong`).toString('base64')}`,
        },
      );
      expect(authStatuses).toEqual([401, 401]);
    });

    await test.step('Chromium consumes the emitted manifest and controls the page with the generated worker', async () => {
      cdp = await context.newCDPSession(page);
      const emitted = await cdpSend<{
        url: string;
        errors: unknown[];
        data: string;
      }>(cdp, 'Page.getAppManifest');
      expect(emitted.url).toBe(`${UI_ORIGIN}/manifest.webmanifest`);
      expect(emitted.errors).toEqual([]);
      expect(JSON.parse(emitted.data)).toMatchObject({
        name: 'OpenPalm',
        start_url: '/chat',
        scope: '/',
        display: 'standalone',
      });

      const worker = await waitForServiceWorker(page);
      expect(worker).toEqual({ scriptURL: `${UI_ORIGIN}/service-worker.js`, controlled: true });
      await expect.poll(async () => (await cacheSnapshot(page)).names).toHaveLength(1);
      const shell = await cacheSnapshot(page);
      expect(shell.names[0]).toMatch(/^openpalm-shell-/);
      expect(shell.urls).toContain(`${UI_ORIGIN}/manifest.webmanifest`);
      expect(shell.urls.some((url) => new URL(url).pathname.startsWith('/_app/'))).toBe(true);
    });

    await test.step('the actual UI stores credentials, saves two connections, and switches back to the fixture', async () => {
      await page.getByLabel('Label').fill('Authenticated fixture');
      await page.getByLabel('URL').fill(FIXTURE_ORIGIN);
      await page.getByLabel('Username (optional)').fill(FIXTURE_USERNAME);
      await page.getByLabel('Server password (optional)').fill(FIXTURE_PASSWORD);
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await page.getByRole('button', { name: '+ Add connection' }).click();
      await page.getByLabel('Label').fill('Secondary fixture');
      await page.getByLabel('URL').fill(SECONDARY_FIXTURE_ORIGIN);
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      const workingCard = page.getByRole('article').filter({ hasText: 'Authenticated fixture' });
      const secondaryCard = page.getByRole('article').filter({ hasText: 'Secondary fixture' });
      const saved = await indexedDbSnapshot(page);
      expect(saved.connections.map(({ label, baseUrl }) => ({ label, baseUrl }))).toEqual([
        { label: 'Authenticated fixture', baseUrl: FIXTURE_ORIGIN },
        { label: 'Secondary fixture', baseUrl: SECONDARY_FIXTURE_ORIGIN },
      ]);
      const working = saved.connections.find((connection) => connection.label === 'Authenticated fixture');
      const secondary = saved.connections.find((connection) => connection.label === 'Secondary fixture');
      expect(working?.auth).toMatchObject({ mode: 'basic', username: FIXTURE_USERNAME });
      expect(JSON.stringify(saved)).not.toContain(FIXTURE_PASSWORD);
      const encryptedSecret = saved.meta.find(({ key }) => key.startsWith('secret:'));
      expect(encryptedSecret).toBeDefined();
      expect(JSON.parse(encryptedSecret?.value ?? '{}')).toMatchObject({ v: 2 });

      if (!working || !secondary) throw new Error('Saved connection records were incomplete');
      const activate = async (card: Locator, id: string): Promise<void> => {
        const button = card.getByRole('button', { name: 'Use this' });
        await expect(button).toBeVisible();
        await button.click();
        await expect.poll(async () => (await indexedDbSnapshot(page)).activeId).toBe(id);
        await expect(card).toContainText('Active');
      };

      if ((await workingCard.getByRole('button', { name: 'Use this' }).count()) === 0) {
        await activate(secondaryCard, secondary.id);
      }
      await activate(workingCard, working.id);
      await activate(secondaryCard, secondary.id);
      await activate(workingCard, working.id);

      const switched = await indexedDbSnapshot(page);
      expect(switched.activeId).toBe(working.id);

      await page.goto(`${UI_ORIGIN}/connections?tab=connections`, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('article').filter({ hasText: 'Authenticated fixture' })).toContainText('Active');
      await expect(page.getByRole('article').filter({ hasText: 'Secondary fixture' })).toBeVisible();
    });

    let standalonePage: Page | undefined;
    await test.step('Chromium reports installability and reopens the profile in native standalone app mode', async () => {
      if (!cdp) throw new Error('CDP session was not initialized');
      const installability = await cdpSend<{ installabilityErrors: unknown[] }>(
        cdp,
        'Page.getInstallabilityErrors',
      );
      expect(installability.installabilityErrors).toEqual([]);

      // The pinned Chromium protocol has no PWA.install command and its media
      // emulation cannot override display-mode. Chromium's own --app launch is
      // reliable, observable app-window behavior without mocking matchMedia.
      // It does not perform an OS-level PWA installation; that remains manual.
      if (!browser || !chromiumProcess) throw new Error('Initial Chromium process was not initialized');
      await closeChromium(browser, chromiumProcess);
      browser = undefined;
      chromiumProcess = undefined;
      context = undefined;
      const standalone = await launchChromium(profile, executablePath, true);
      browser = standalone.browser;
      chromiumProcess = standalone.process;
      context = standalone.context;
      standalonePage = standalone.page;
      context.on('request', (request) => {
        if (request.url().startsWith(FIXTURE_ORIGIN)) {
          fixtureRequests.push({ method: request.method(), url: request.url() });
        }
      });
      context.on('response', (response) => {
        if (response.ok() && response.url().endsWith('/event')) {
          fixtureEventContentTypes.push(response.headers()['content-type'] ?? '');
        }
      });

      await standalonePage.goto(`${UI_ORIGIN}/chat`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => standalonePage?.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
      await expect(standalonePage).toHaveURL(/\/chat(?:\?|$)/);
      await expect(standalonePage.getByLabel('Manage assistant')).toHaveCount(0);
    });

    await test.step('the standalone app restores both records and active auth, then chats over SSE', async () => {
      if (!standalonePage) throw new Error('Standalone page was not initialized');
      await expect.poll(async () => (await indexedDbSnapshot(standalonePage)).connections.length).toBe(2);
      const reopened = await indexedDbSnapshot(standalonePage);
      expect(reopened.connections.map(({ label, baseUrl }) => ({ label, baseUrl }))).toEqual([
        { label: 'Authenticated fixture', baseUrl: FIXTURE_ORIGIN },
        { label: 'Secondary fixture', baseUrl: SECONDARY_FIXTURE_ORIGIN },
      ]);
      const working = reopened.connections.find((connection) => connection.label === 'Authenticated fixture');
      expect(reopened.activeId).toBe(working?.id);
      expect(JSON.stringify(reopened)).not.toContain(FIXTURE_PASSWORD);
      await expect(standalonePage.getByLabel('Message input')).toBeVisible();
      await expect(standalonePage.getByText('Authenticated fixture', { exact: true }).first()).toBeVisible();
      await expect.poll(async () => (await fixtureState()).activeEventStreams).toBe(1);
      expect(fixtureEventContentTypes).toContain('text/event-stream');

      const prompt = 'hello from the PWA';
      await standalonePage.getByLabel('Message input').fill(prompt);
      await standalonePage.getByLabel('Send message').click();
      await expect(standalonePage.getByText(`Fixture reply: ${prompt}`, { exact: true })).toBeVisible();
      expect(fixtureRequests.some(({ method, url }) => method === 'POST' && url.endsWith('/session'))).toBe(true);
      expect(
        fixtureRequests.some(
          ({ method, url }) => method === 'POST' && /\/session\/[^/]+\/message$/.test(url),
        ),
      ).toBe(true);
      expect(fixtureRequests.some(({ method, url }) => method === 'GET' && url.endsWith('/event'))).toBe(true);
      await expect.poll(async () => (await fixtureState()).messagePosts).toBe(1);
      const state = await fixtureState();
      expect(state.authorizedRequests).toBeGreaterThan(0);
      expect(state.rejectedAuth).toBeGreaterThanOrEqual(2);
    });

    await test.step('page, sensitive, API, and cross-origin traffic stays outside CacheStorage', async () => {
      if (!standalonePage) throw new Error('Standalone page was not initialized');
      const statuses = await standalonePage.evaluate(async (fixtureOrigin) => {
        const responses = await Promise.all([
          fetch('/login', { headers: { accept: 'text/html' }, cache: 'no-store' }),
          fetch('/api/runtime', { cache: 'no-store' }),
          fetch('/health', { cache: 'no-store' }),
          fetch('/api/host/health', { cache: 'no-store' }),
          fetch(`${fixtureOrigin}/`, { cache: 'no-store' }),
        ]);
        return responses.map((response) => response.status);
      }, FIXTURE_ORIGIN);
      expect(statuses).toEqual([200, 200, 200, 403, 401]);

      const shell = await cacheSnapshot(standalonePage);
      const cachedPaths = shell.urls.map((url) => new URL(url).pathname);
      expect(cachedPaths).not.toContain('/chat');
      expect(cachedPaths).not.toContain('/connections');
      expect(cachedPaths).not.toContain('/login');
      expect(cachedPaths).not.toContain('/api/runtime');
      expect(cachedPaths).not.toContain('/api/runtime-config');
      expect(cachedPaths).not.toContain('/api/host/health');
      expect(cachedPaths).not.toContain('/health');
      expect(cachedPaths).not.toContain('/runtime-config.json');
      expect(shell.urls.some((url) => url.startsWith(FIXTURE_ORIGIN))).toBe(false);

      await context.setOffline(true);
      try {
        const offline = await standalonePage.evaluate(async (fixtureOrigin) => {
          const cachedManifest = await fetch('/manifest.webmanifest?offline-proof=1').then((response) => response.json());
          const networkOnly = await Promise.all(
            [
              '/chat?offline-proof=1',
              '/api/runtime?offline-proof=1',
              `${fixtureOrigin}/?offline-proof=1`,
            ].map(async (url) => {
              try {
                await fetch(url, { cache: 'no-store' });
                return true;
              } catch {
                return false;
              }
            }),
          );
          return { cachedManifest, networkOnly };
        }, FIXTURE_ORIGIN);
        expect(offline.cachedManifest).toMatchObject({ name: 'OpenPalm' });
        expect(offline.networkOnly).toEqual([false, false, false]);
      } finally {
        await context.setOffline(false);
      }
    });
  } catch (error) {
    bodyError = error;
  }

  let cleanupError: unknown;
  try {
    if (browser && chromiumProcess) await closeChromium(browser, chromiumProcess);
    else if (chromiumProcess) await stopChromiumProcess(chromiumProcess);
  } catch (error) {
    cleanupError = error;
  }
  try {
    await removeProfile(profile);
  } catch (error) {
    cleanupError ??= error;
  }
  if (bodyError && cleanupError) throw new AggregateError([bodyError, cleanupError], 'PWA test and cleanup failed');
  if (bodyError) throw bodyError;
  if (cleanupError) throw cleanupError;
});
