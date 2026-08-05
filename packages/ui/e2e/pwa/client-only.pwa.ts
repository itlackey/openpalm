import { chromium } from '@playwright/test';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockAmbientLocalDiscovery, expect, test } from '../fixtures.js';
import { resolveChromiumLaunchTarget } from './chromium-launch-target.js';

const UI_PORT = process.env.OP_PWA_UI_PORT ?? '4174';
const FIXTURE_PORT = process.env.OP_PWA_FIXTURE_PORT ?? '4175';
const HOST_UI_PORT = process.env.OP_PWA_HOST_UI_PORT ?? '4176';
const UI_ORIGIN = `http://localhost:${UI_PORT}`;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const HOST_UI_ORIGIN = `http://localhost:${HOST_UI_PORT}`;
const SECURE_UI_ORIGIN = 'https://secure-openpalm.test';
const FIXTURE_USERNAME = 'pwa-user';
const FIXTURE_PASSWORD = 'pwa-secret-password';
const NEWEST_SESSION_ID = 'fixture-newest-session';
const OLDER_SESSION_ID = 'fixture-older-session';
const NEWEST_TRANSCRIPT = 'Newest fixture transcript';
const OLDER_TRANSCRIPT = 'Older fixture transcript';
const LOCAL_CHOICE_TEXT = 'Set up OpenPalm on this computer';

const chromiumLaunchTarget = resolveChromiumLaunchTarget(
  process.env.OP_PLAYWRIGHT_EXECUTABLE_PATH,
  chromium.executablePath(),
);

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
  storeNames: string[];
  storedStrings: string[];
};

type FixtureState = {
  authorizedRequests: number;
  rejectedAuth: number;
  eventConnections: number;
  eventClosed: number;
  messagePosts: number;
  sessionListRequests: number;
  pendingVerificationRequests: number;
  activeEventStreams: number;
  sessions: number;
  messages: number;
  sessionIds: string[];
};

type LaunchedChromium = {
  context: BrowserContext;
  page: Page;
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
          const storeNames = [...db.objectStoreNames];
          const transaction = db.transaction(storeNames, 'readonly');
          const values = new Map<string, IDBRequest<unknown[]>>();
          const keys = new Map<string, IDBRequest<IDBValidKey[]>>();
          for (const name of storeNames) {
            const store = transaction.objectStore(name);
            values.set(name, store.getAll());
            keys.set(name, store.getAllKeys());
          }
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => {
            const strings = new Set<string>();
            const collectStrings = (value: unknown): void => {
              if (typeof value === 'string') {
                strings.add(value);
                return;
              }
              if (Array.isArray(value)) {
                for (const item of value) collectStrings(item);
                return;
              }
              if (typeof value !== 'object' || value === null) return;
              for (const item of Object.values(value)) collectStrings(item);
            };
            for (const name of storeNames) {
              collectStrings(name);
              collectStrings(values.get(name)?.result ?? []);
              collectStrings(keys.get(name)?.result ?? []);
            }

            const connections = ((values.get('connections')?.result ?? []) as StoredConnection[])
              .map((entry) => ({
                id: entry.id,
                label: entry.label,
                baseUrl: entry.baseUrl,
                auth: entry.auth,
              }))
              .sort((a, b) => a.label.localeCompare(b.label));
            const metaKeys = (keys.get('meta')?.result ?? []).map(String);
            const metaValues = values.get('meta')?.result ?? [];
            const meta = metaKeys.flatMap((key, index) =>
              typeof metaValues[index] === 'string'
                ? [{ key, value: metaValues[index] as string }]
                : [],
            );
            const active = meta.find(({ key }) => key === 'activeId')?.value ?? null;
            resolve({
              connections,
              activeId: active,
              meta,
              storeNames,
              storedStrings: [...strings].sort(),
            });
            db.close();
          };
        };
      }),
  );
}

async function fixtureControl(path: string, init?: RequestInit): Promise<FixtureState> {
  const response = await fetch(`${FIXTURE_ORIGIN}${path}`, init);
  if (!response.ok) throw new Error(`Fixture control ${path} failed: HTTP ${response.status}`);
  return response.json() as Promise<FixtureState>;
}

async function fixtureState(): Promise<FixtureState> {
  return fixtureControl('/__test/state');
}

async function pauseVerification(): Promise<void> {
  await fixtureControl('/__test/verification/pause', { method: 'POST' });
}

async function releaseVerification(): Promise<void> {
  await fixtureControl('/__test/verification/release', { method: 'POST' });
}

function fixtureMessage(id: string, text: string) {
  return {
    info: { id, role: 'user', time: { created: 1 } },
    parts: [{ type: 'text', text }],
  };
}

async function seedFixtureSessions(): Promise<void> {
  await fixtureControl('/__test/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessions: [
        {
          id: NEWEST_SESSION_ID,
          title: 'Newest conversation',
          time: { created: 2_000, updated: 2_000 },
          messages: [fixtureMessage('newest-message', NEWEST_TRANSCRIPT)],
        },
        {
          id: OLDER_SESSION_ID,
          title: 'Older conversation',
          time: { created: 1_000, updated: 1_000 },
          messages: [fixtureMessage('older-message', OLDER_TRANSCRIPT)],
        },
      ],
    }),
  });
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
  standalone: boolean,
): Promise<LaunchedChromium> {
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...chromiumLaunchTarget,
      headless: true,
      ignoreDefaultArgs: standalone ? ['about:blank'] : undefined,
      args: standalone ? [`--app=${UI_ORIGIN}/manifest.webmanifest`] : [],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not launch Chromium with persistent profile ${profile}: ${detail}`, {
      cause: error,
    });
  }

  let page = context.pages()[0];
  for (let attempt = 0; !page && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    page = context.pages()[0];
  }
  if (!page) {
    await closeChromium(context);
    throw new Error('Chromium did not open a page');
  }
  await blockAmbientLocalDiscovery(context);
  return { context, page };
}

async function closeChromium(context: BrowserContext): Promise<void> {
  await context.close();
}

async function installLocalChoiceObserver(page: Page): Promise<void> {
  await page.addInitScript((needle) => {
    const flashes: number[] = [];
    Object.defineProperty(window, '__openpalmLocalChoiceFlashes', { value: flashes });
    const inspect = (): void => {
      if (document.documentElement?.textContent?.includes(needle)) flashes.push(performance.now());
    };
    new MutationObserver(inspect).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    document.addEventListener('DOMContentLoaded', inspect, { once: true });
  }, LOCAL_CHOICE_TEXT);
}

async function localChoiceFlashes(page: Page): Promise<number[]> {
  return page.evaluate(
    () => (window as Window & { __openpalmLocalChoiceFlashes?: number[] }).__openpalmLocalChoiceFlashes ?? [],
  );
}

async function installServiceWorkerReadyObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { scriptURL: '', resolved: false };
    Object.defineProperty(window, '__openpalmServiceWorkerReady', { value: state });
    void navigator.serviceWorker.ready.then((registration) => {
      state.scriptURL = registration.active?.scriptURL ?? '';
      state.resolved = true;
    });
  });
}

async function serviceWorkerReadyState(page: Page): Promise<{ scriptURL: string; resolved: boolean }> {
  return page.evaluate(
    () =>
      (window as Window & {
        __openpalmServiceWorkerReady?: { scriptURL: string; resolved: boolean };
      }).__openpalmServiceWorkerReady ?? { scriptURL: '', resolved: false },
  );
}

async function openManualWizard(page: Page, origin = UI_ORIGIN): Promise<void> {
  await page.goto(`${origin}/connections/new`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Connect to OpenPalm' })).toBeVisible();
  await page.getByRole('button', { name: 'Enter an address instead' }).click();
}

async function fillManualConnection(
  page: Page,
  input: { label: string; url: string; username?: string; password?: string },
): Promise<void> {
  await page.getByLabel('Name', { exact: true }).fill(input.label);
  await page.getByLabel('Address', { exact: true }).fill(input.url);
  await page.getByLabel('Username', { exact: true }).fill(input.username ?? '');
  await page.getByLabel('Password', { exact: true }).fill(input.password ?? '');
}

function pairingCode(input: { label: string; url: string; username: string; secret: string }): string {
  return `openpalm-pair:${Buffer.from(
    JSON.stringify({ v: 1, kind: 'openpalm-connection', ...input }),
  ).toString('base64url')}`;
}

async function proxySecureOrigin(context: BrowserContext): Promise<void> {
  await context.route((url) => url.origin === SECURE_UI_ORIGIN, async (route) => {
    const request = route.request();
    const source = new URL(request.url());
    const headers = { ...request.headers() };
    delete headers.host;
    delete headers.origin;
    delete headers.referer;
    const response = await route.fetch({
      url: `${UI_ORIGIN}${source.pathname}${source.search}`,
      headers,
    });
    try {
      await route.fulfill({ response });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Route is already handled')) return;
      throw error;
    }
  });
}

async function waitForOrigin(origin: string): Promise<void> {
  await expect
    .poll(async () => {
      try {
        return (await fetch(`${origin}/manifest.webmanifest`)).status;
      } catch {
        return 0;
      }
    })
    .toBe(200);
}

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${FIXTURE_ORIGIN}/__test/reset`);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    sessions: 0,
    messages: 0,
    activeEventStreams: 0,
    pendingVerificationRequests: 0,
  });
});

test('direct onboarding registers the root service worker and reaches ready before navigation', async ({
  context,
  page,
}) => {
  const workerRequests: string[] = [];
  context.on('request', (request) => {
    if (request.url().includes('service-worker.js')) workerRequests.push(request.url());
  });
  await installServiceWorkerReadyObserver(page);

  await page.goto(`${UI_ORIGIN}/connections/new`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(`${UI_ORIGIN}/connections/new`);
  await expect(page.getByRole('heading', { name: 'Connect to OpenPalm' })).toBeVisible();
  await expect.poll(async () => (await serviceWorkerReadyState(page)).resolved).toBe(true);
  expect(await serviceWorkerReadyState(page)).toEqual({
    scriptURL: `${UI_ORIGIN}/service-worker.js`,
    resolved: true,
  });
  expect(workerRequests).toContain(`${UI_ORIGIN}/service-worker.js`);
  expect(workerRequests).not.toContain(`${UI_ORIGIN}/connections/service-worker.js`);
});

test('empty client and standalone PWA starts reach onboarding without Back or a Start loop', async ({
  page,
}) => {
  await installLocalChoiceObserver(page);
  await page.goto(UI_ORIGIN, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(`${UI_ORIGIN}/connections/new?onboarding=1`);
  await expect(page.getByRole('heading', { name: 'Connect to OpenPalm' })).toBeVisible();
  await expect(page.getByText(LOCAL_CHOICE_TEXT)).toHaveCount(0);
  await expect(page.getByText('Back', { exact: true })).toHaveCount(0);
  expect(await localChoiceFlashes(page)).toEqual([]);

  const profile = await mkdtemp(join(tmpdir(), 'openpalm-pwa-empty-standalone-'));
  let launched: LaunchedChromium | undefined;
  try {
    launched = await launchChromium(profile, true);
    const navigationPaths: string[] = [];
    launched.page.on('framenavigated', (frame) => {
      if (frame === launched?.page.mainFrame()) navigationPaths.push(new URL(frame.url()).pathname);
    });
    await installLocalChoiceObserver(launched.page);
    await launched.page.goto(`${UI_ORIGIN}/chat`, { waitUntil: 'domcontentloaded' });
    await expect(launched.page).toHaveURL(`${UI_ORIGIN}/connections/new?onboarding=1`);
    await expect(launched.page.getByRole('heading', { name: 'Connect to OpenPalm' })).toBeVisible();
    await expect(launched.page.getByText(LOCAL_CHOICE_TEXT)).toHaveCount(0);
    await expect(launched.page.getByText('Back', { exact: true })).toHaveCount(0);
    expect(await localChoiceFlashes(launched.page)).toEqual([]);
    expect(navigationPaths).not.toContain('/setup');
    expect(await launched.page.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
  } finally {
    if (launched) await closeChromium(launched.context);
    await removeProfile(profile);
  }
});

test('host onboarding Back ignores a successful verification response that arrives after cancellation', async ({
  page,
}) => {
  await waitForOrigin(HOST_UI_ORIGIN);
  await page.goto(HOST_UI_ORIGIN, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/connections/new?onboarding=1`);
  await page.getByText('Connect to an existing OpenPalm').click();
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/connections/new?onboarding=1`);
  await page.getByRole('button', { name: 'Enter an address instead' }).click();
  await fillManualConnection(page, {
    label: 'Cancelled delayed fixture',
    url: FIXTURE_ORIGIN,
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
  });
  const before = await indexedDbSnapshot(page);
  await pauseVerification();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(async () => (await fixtureState()).pendingVerificationRequests).toBe(1);
  expect(await indexedDbSnapshot(page)).toEqual(before);

  const delayedResponse = page.waitForResponse(
    (response) => response.url() === `${FIXTURE_ORIGIN}/session` && response.status() === 200,
  );
  await page.getByText('Back', { exact: true }).click();
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/connections/new?onboarding=1`);
  await expect(page.getByRole('heading', { name: 'Welcome to OpenPalm' })).toBeVisible();

  await releaseVerification();
  await delayedResponse;
  await expect.poll(async () => (await fixtureState()).pendingVerificationRequests).toBe(0);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/connections/new?onboarding=1`);
  await expect(page.getByRole('heading', { name: 'Welcome to OpenPalm' })).toBeVisible();
  expect(await indexedDbSnapshot(page)).toEqual(before);
});

test('manual verification failures retain every input and leave IndexedDB unchanged before retry', async ({
  context,
  page,
}) => {
  await context.route('http://unreachable.openpalm.invalid/**', (route) =>
    route.abort('connectionrefused'),
  );
  await openManualWizard(page);
  const before = await indexedDbSnapshot(page);

  const cases = [
    {
      input: { label: 'Invalid address', url: 'not a URL', username: 'kept-user', password: 'kept-invalid' },
      error: 'Check the address. It should begin with http:// or https://',
    },
    {
      input: {
        label: 'Unreachable address',
        url: 'http://unreachable.openpalm.invalid',
        username: 'kept-user',
        password: 'kept-unreachable',
      },
      error: 'This browser could not reach OpenPalm.',
    },
    {
      input: {
        label: 'Rejected credentials',
        url: FIXTURE_ORIGIN,
        username: FIXTURE_USERNAME,
        password: 'wrong-password',
      },
      error: 'OpenPalm did not accept these sign-in details.',
    },
  ];

  for (const scenario of cases) {
    await fillManualConnection(page, scenario.input);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(scenario.error);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(scenario.input.label);
    await expect(page.getByLabel('Address', { exact: true })).toHaveValue(scenario.input.url);
    await expect(page.getByLabel('Username', { exact: true })).toHaveValue(scenario.input.username);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(scenario.input.password);
    expect(await indexedDbSnapshot(page)).toEqual(before);
  }
});

test('secure-origin mixed-content rejection retains input without network or IndexedDB writes', async ({
  context,
  page,
}) => {
  await proxySecureOrigin(context);
  try {
    const attemptedTargets: string[] = [];
    context.on('request', (request) => {
      if (request.url().startsWith('http://192.0.2.1:4175')) attemptedTargets.push(request.url());
    });

    await openManualWizard(page, SECURE_UI_ORIGIN);
    const before = await indexedDbSnapshot(page);
    const input = {
      label: 'Plain HTTP remote',
      url: 'http://192.0.2.1:4175',
      username: 'mixed-user',
      password: 'mixed-secret',
    };
    await fillManualConnection(page, input);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(page.getByRole('alert')).toContainText('cannot connect safely to that address');
    await expect(page.getByRole('alert').getByRole('link', { name: 'Open the HTTPS setup guide' })).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(input.label);
    await expect(page.getByLabel('Address', { exact: true })).toHaveValue(input.url);
    await expect(page.getByLabel('Username', { exact: true })).toHaveValue(input.username);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(input.password);
    expect(attemptedTargets).toEqual([]);
    expect(await indexedDbSnapshot(page)).toEqual(before);
  } finally {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('pairing verifies before writing, stores the encrypted secret and active ID, then replace-navigates to Chat', async ({
  page,
}) => {
  await page.goto(`${UI_ORIGIN}/connections/new`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Connect to OpenPalm' })).toBeVisible();
  const before = await indexedDbSnapshot(page);
  const historyLength = await page.evaluate(() => history.length);
  await pauseVerification();

  await page.getByLabel('Pairing code').fill(
    pairingCode({
      label: 'Paired fixture',
      url: FIXTURE_ORIGIN,
      username: FIXTURE_USERNAME,
      secret: FIXTURE_PASSWORD,
    }),
  );
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(async () => (await fixtureState()).pendingVerificationRequests).toBe(1);
  expect(await indexedDbSnapshot(page)).toEqual(before);

  await releaseVerification();
  await expect(page).toHaveURL(/\/chat\?assistant=[^&]+$/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  const saved = await indexedDbSnapshot(page);
  expect(saved.connections).toHaveLength(1);
  expect(saved.connections[0]).toMatchObject({
    label: 'Paired fixture',
    baseUrl: `${FIXTURE_ORIGIN}/oc`,
    auth: { mode: 'basic', username: FIXTURE_USERNAME },
  });
  expect(saved.activeId).toBe(saved.connections[0]?.id);
  expect(saved.meta.some(({ key }) => key.startsWith('secret:'))).toBe(true);
  expect(saved.storedStrings).not.toContain(FIXTURE_PASSWORD);
});

test('manual onboarding persists a real profile, restores a non-newest session, and repairs a deleted cursor', async () => {
  await seedFixtureSessions();
  const profile = await mkdtemp(join(tmpdir(), 'openpalm-pwa-chromium-'));
  let launched: LaunchedChromium | undefined;
  let bodyError: unknown;

  try {
    launched = await launchChromium(profile, false);
    const fixtureRequests: Array<{ method: string; url: string }> = [];
    const fixtureEventContentTypes: string[] = [];
    launched.context.on('request', (request) => {
      if (request.url().startsWith(FIXTURE_ORIGIN)) {
        fixtureRequests.push({ method: request.method(), url: request.url() });
      }
    });
    launched.context.on('response', (response) => {
      if (response.ok() && response.url().endsWith('/event')) {
        fixtureEventContentTypes.push(response.headers()['content-type'] ?? '');
      }
    });

    const page = launched.page;
    await openManualWizard(page);
    const beforeSave = await indexedDbSnapshot(page);
    const historyLength = await page.evaluate(() => history.length);
    await fillManualConnection(page, {
      label: 'Authenticated fixture',
      url: FIXTURE_ORIGIN,
      username: FIXTURE_USERNAME,
      password: FIXTURE_PASSWORD,
    });
    await pauseVerification();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect.poll(async () => (await fixtureState()).pendingVerificationRequests).toBe(1);
    expect(await indexedDbSnapshot(page)).toEqual(beforeSave);
    await releaseVerification();

    await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(NEWEST_SESSION_ID);
    const saved = await indexedDbSnapshot(page);
    const connection = saved.connections[0];
    if (!connection) throw new Error('Manual onboarding did not save its connection');
    expect(new URL(page.url()).searchParams.get('assistant')).toBe(connection.id);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    expect(saved.activeId).toBe(connection.id);
    expect(saved.connections).toEqual([
      {
        id: connection.id,
        label: 'Authenticated fixture',
        baseUrl: FIXTURE_ORIGIN,
        auth: {
          mode: 'basic',
          username: FIXTURE_USERNAME,
          secretRef: connection.auth.secretRef,
        },
      },
    ]);
    const encryptedSecret = saved.meta.find(({ key }) => key.startsWith('secret:'));
    expect(encryptedSecret).toBeDefined();
    expect(JSON.parse(encryptedSecret?.value ?? '{}')).toMatchObject({ v: 2 });
    expect(saved.storedStrings).not.toContain(FIXTURE_PASSWORD);

    await page.getByRole('button', { name: 'Conversation: Newest conversation' }).click();
    await page.getByRole('button', { name: /Resume conversation: Older conversation/ }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(OLDER_SESSION_ID);
    await expect(page.getByText(OLDER_TRANSCRIPT, { exact: true })).toBeVisible();
    await expect
      .poll(async () =>
        (await indexedDbSnapshot(page)).meta.find(({ key }) => key === `lastSession:${connection.id}`)?.value,
      )
      .toBe(OLDER_SESSION_ID);

    const cdp = await launched.context.newCDPSession(page);
    const emitted = await cdpSend<{ url: string; errors: unknown[]; data: string }>(
      cdp,
      'Page.getAppManifest',
    );
    expect(emitted.url).toBe(`${UI_ORIGIN}/manifest.webmanifest`);
    expect(emitted.errors).toEqual([]);
    expect(JSON.parse(emitted.data)).toMatchObject({
      name: 'OpenPalm',
      start_url: '/chat',
      scope: '/',
      display: 'standalone',
    });
    expect(await waitForServiceWorker(page)).toEqual({
      scriptURL: `${UI_ORIGIN}/service-worker.js`,
      controlled: true,
    });
    const installability = await cdpSend<{ installabilityErrors: unknown[] }>(
      cdp,
      'Page.getInstallabilityErrors',
    );
    expect(installability.installabilityErrors).toEqual([]);
    await expect.poll(async () => (await cacheSnapshot(page)).names).toHaveLength(1);

    await closeChromium(launched.context);
    launched = undefined;

    launched = await launchChromium(profile, true);
    launched.context.on('request', (request) => {
      if (request.url().startsWith(FIXTURE_ORIGIN)) {
        fixtureRequests.push({ method: request.method(), url: request.url() });
      }
    });
    launched.context.on('response', (response) => {
      if (response.ok() && response.url().endsWith('/event')) {
        fixtureEventContentTypes.push(response.headers()['content-type'] ?? '');
      }
    });
    let standalonePage = launched.page;
    await standalonePage.goto(`${UI_ORIGIN}/chat`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => standalonePage.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
    await expect.poll(() => new URL(standalonePage.url()).searchParams.get('assistant')).toBe(connection.id);
    await expect.poll(() => new URL(standalonePage.url()).searchParams.get('session')).toBe(OLDER_SESSION_ID);
    await expect(standalonePage.getByText(OLDER_TRANSCRIPT, { exact: true })).toBeVisible();
    expect((await indexedDbSnapshot(standalonePage)).activeId).toBe(connection.id);
    await expect.poll(async () => (await fixtureState()).activeEventStreams).toBe(1);
    expect(fixtureEventContentTypes).toContain('text/event-stream');

    const prompt = 'hello from the restored PWA session';
    const reply = `Fixture reply: ${prompt}`;
    await standalonePage.getByLabel('Message input').fill(prompt);
    await standalonePage.getByLabel('Send message').click();
    await expect(standalonePage.getByText(reply, { exact: true })).toBeVisible();
    expect(
      fixtureRequests.some(
        ({ method, url }) => method === 'POST' && url.endsWith(`/session/${OLDER_SESSION_ID}/message`),
      ),
    ).toBe(true);
    await expect.poll(async () => (await fixtureState()).messagePosts).toBe(1);
    const afterChat = await indexedDbSnapshot(standalonePage);
    expect(afterChat.storedStrings).not.toContain(FIXTURE_PASSWORD);
    expect(afterChat.storedStrings).not.toContain(prompt);
    expect(afterChat.storedStrings).not.toContain(reply);
    expect(afterChat.storedStrings).not.toContain(OLDER_TRANSCRIPT);
    expect(afterChat.storedStrings).not.toContain(NEWEST_TRANSCRIPT);

    const shell = await cacheSnapshot(standalonePage);
    expect(shell.names[0]).toMatch(/^openpalm-shell-/);
    expect(shell.urls).toContain(`${UI_ORIGIN}/manifest.webmanifest`);
    expect(shell.urls.some((url) => new URL(url).pathname.startsWith('/_app/'))).toBe(true);
    const cachedPaths = shell.urls.map((url) => new URL(url).pathname);
    expect(cachedPaths).not.toContain('/chat');
    expect(cachedPaths).not.toContain('/connections/new');
    expect(cachedPaths).not.toContain('/login');
    expect(cachedPaths).not.toContain('/api/runtime');
    expect(cachedPaths).not.toContain('/api/runtime-config');
    expect(shell.urls.some((url) => url.startsWith(FIXTURE_ORIGIN))).toBe(false);

    await launched.context.setOffline(true);
    try {
      const offline = await standalonePage.evaluate(async (fixtureOrigin) => {
        const cachedManifest = await fetch('/manifest.webmanifest?offline-proof=1').then((response) =>
          response.json(),
        );
        const networkOnly = await Promise.all(
          ['/chat?offline-proof=1', '/api/runtime?offline-proof=1', `${fixtureOrigin}/?offline-proof=1`].map(
            async (url) => {
              try {
                await fetch(url, { cache: 'no-store' });
                return true;
              } catch {
                return false;
              }
            },
          ),
        );
        return { cachedManifest, networkOnly };
      }, FIXTURE_ORIGIN);
      expect(offline.cachedManifest).toMatchObject({ name: 'OpenPalm' });
      expect(offline.networkOnly).toEqual([false, false, false]);
    } finally {
      await launched.context.setOffline(false);
    }

    await closeChromium(launched.context);
    launched = undefined;
    const deleted = await fixtureControl(`/__test/session/${encodeURIComponent(OLDER_SESSION_ID)}`, {
      method: 'DELETE',
    });
    expect(deleted.sessionIds).toEqual([NEWEST_SESSION_ID]);

    launched = await launchChromium(profile, true);
    standalonePage = launched.page;
    await standalonePage.goto(`${UI_ORIGIN}/chat`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => new URL(standalonePage.url()).searchParams.get('assistant')).toBe(connection.id);
    await expect.poll(() => new URL(standalonePage.url()).searchParams.get('session')).toBe(NEWEST_SESSION_ID);
    await expect(standalonePage.getByText(NEWEST_TRANSCRIPT, { exact: true })).toBeVisible();
    const repaired = await indexedDbSnapshot(standalonePage);
    expect(repaired.activeId).toBe(connection.id);
    expect(repaired.meta.find(({ key }) => key === `lastSession:${connection.id}`)?.value).toBe(
      NEWEST_SESSION_ID,
    );
    expect(repaired.storedStrings).not.toContain(FIXTURE_PASSWORD);
    expect(repaired.storedStrings).not.toContain(OLDER_TRANSCRIPT);
    expect(repaired.storedStrings).not.toContain(NEWEST_TRANSCRIPT);
    const state = await fixtureState();
    expect(state.authorizedRequests).toBeGreaterThan(0);
    expect(state.sessions).toBe(1);
  } catch (error) {
    bodyError = error;
  }

  let cleanupError: unknown;
  try {
    if (launched) await closeChromium(launched.context);
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

test('host-capable first run offers both branches and wizard Back returns to the chooser', async ({ page }) => {
  await waitForOrigin(HOST_UI_ORIGIN);
  await page.route(`${HOST_UI_ORIGIN}/api/setup/system-check`, (route) =>
    route.fulfill({
      json: {
        ok: true,
        docker: { ok: false, error: 'spawn docker ENOENT' },
        compose: { ok: false, error: 'Docker Compose v2 not found' },
        portCheckReliable: false,
        ports: [],
        platform: 'linux',
        runtime: { dockerPresent: false, composeAvailable: false, runtimeName: 'Docker' },
      },
    }),
  );

  await page.goto(HOST_UI_ORIGIN, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/connections/new?onboarding=1`);
  await expect(page.getByRole('heading', { name: 'Welcome to OpenPalm' })).toBeVisible();
  await expect(page.getByText(LOCAL_CHOICE_TEXT)).toBeVisible();
  await expect(page.getByText('Connect to an existing OpenPalm')).toBeVisible();

  await page.getByText('Connect to an existing OpenPalm').click();
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/connections/new?onboarding=1`);
  await expect(page.getByRole('heading', { name: 'Connect to OpenPalm' })).toBeVisible();
  await expect(page.getByText('Back', { exact: true })).toBeVisible();
  await page.getByText('Back', { exact: true }).click();
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/connections/new?onboarding=1`);
  await expect(page.getByRole('heading', { name: 'Welcome to OpenPalm' })).toBeVisible();

  await page.getByText(LOCAL_CHOICE_TEXT).click();
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/setup`);
  await expect(page.getByRole('heading', { name: 'System Check' })).toBeVisible();
  await expect(page.getByText("Docker isn't installed yet.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Install Docker Engine for Linux' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry checks' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/connections/new?onboarding=1`);
  await expect(page.getByRole('heading', { name: 'Welcome to OpenPalm' })).toBeVisible();
});

test('setup completion reloads Chat and reseeds runtime config before using the local assistant', async ({
  page,
}) => {
  await waitForOrigin(HOST_UI_ORIGIN);
  let deploymentComplete = false;
  let runtimeConfigRequests = 0;
  const installedConnection = {
    id: 'post-setup-local',
    label: 'Installed local assistant',
    baseUrl: 'http://post-setup.openpalm.invalid',
    auth: { mode: 'none' },
    isDefault: true,
    locked: true,
  };

  await page.addInitScript(() => {
    const next = Number(sessionStorage.getItem('openpalm-e2e-document-count') ?? '0') + 1;
    sessionStorage.setItem('openpalm-e2e-document-count', String(next));
    Object.defineProperty(window, '__openpalmDocumentCount', { value: next });
  });
  await page.route(`${HOST_UI_ORIGIN}/api/runtime-config`, (route) => {
    runtimeConfigRequests += 1;
    return route.fulfill({
      json: { connections: deploymentComplete ? [installedConnection] : [] },
    });
  });
  await page.route('http://post-setup.openpalm.invalid/**', (route) =>
    route.abort('connectionrefused'),
  );
  await page.route(`${HOST_UI_ORIGIN}/api/setup/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/setup/system-check') {
      await route.fulfill({
        json: {
          ok: true,
          docker: { ok: true, version: 'fixture' },
          compose: { ok: true, version: 'fixture' },
          portCheckReliable: true,
          ports: [],
          platform: 'linux',
          runtime: { dockerPresent: true, composeAvailable: true, runtimeName: 'Docker' },
        },
      });
      return;
    }
    if (path === '/api/setup/complete') {
      deploymentComplete = true;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (path === '/api/setup/deploy-status') {
      await route.fulfill({
        json: deploymentComplete
          ? {
              deploying: false,
              setupComplete: true,
              deployStatus: [{ service: 'assistant', status: 'running' }],
              ports: { admin: Number(HOST_UI_PORT), ui: Number(HOST_UI_PORT), assistant: 3810 },
            }
          : { deploying: false, setupComplete: false, deployStatus: [] },
      });
      return;
    }
    if (path === '/api/setup/status') {
      await route.fulfill({ json: { ok: true, setupComplete: false } });
      return;
    }
    if (path === '/api/setup/host-status') {
      await route.fulfill({ json: { providerCount: 0, credentialCount: 0, hostAkmAvailable: false } });
      return;
    }
    if (path === '/api/setup/voice-profiles' || path === '/api/setup/ollama-profiles') {
      await route.fulfill({ json: { ok: true, profiles: [] } });
      return;
    }
    if (path === '/api/setup/opencode/status') {
      await route.fulfill({ json: { available: false } });
      return;
    }
    if (path === '/api/setup/opencode/providers') {
      await route.fulfill({ json: { available: false, providers: [], auth: {} } });
      return;
    }
    if (path === '/api/setup/detect-providers') {
      await route.fulfill({ json: { providers: [] } });
      return;
    }
    if (path === '/api/setup/recommend') {
      await route.fulfill({ json: { ok: true, cloudProviders: [], hostProviders: [] } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto(HOST_UI_ORIGIN, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/connections/new?onboarding=1`);
  await expect.poll(() => runtimeConfigRequests).toBeGreaterThan(0);
  await page.getByText(LOCAL_CHOICE_TEXT).click();
  await expect(page.locator('[data-testid="step-models"]')).toBeVisible();
  await page.getByRole('button', { name: /i'll set this up later/i }).click();
  await page.locator('#btn-screen1-next').click();
  await expect(page.locator('#step-2')).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#btn-install')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.locator('#btn-install').click();
  await expect(page.locator('#deploy-done')).toBeVisible();

  const documentCountBeforeChat = await page.evaluate(
    () => (window as Window & { __openpalmDocumentCount?: number }).__openpalmDocumentCount ?? 0,
  );
  const runtimeRequestsBeforeChat = runtimeConfigRequests;
  await page.getByRole('link', { name: 'Open Chat', exact: true }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __openpalmDocumentCount?: number }).__openpalmDocumentCount ?? 0,
      ),
    )
    .toBeGreaterThan(documentCountBeforeChat);
  await expect.poll(() => runtimeConfigRequests).toBeGreaterThan(runtimeRequestsBeforeChat);
  await expect(page).toHaveURL(`${HOST_UI_ORIGIN}/chat?assistant=${installedConnection.id}`);
  await expect(page.getByText(installedConnection.label, { exact: true }).first()).toBeVisible();
});
