/**
 * Offline verification uses a dedicated client origin that each test can stop.
 * This avoids Playwright's CDP offline emulation, which disconnects below the
 * service-worker interception layer, while still proving the shell works with
 * both the origin and assistant processes unavailable.
 */
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { type StubAssistant, startStubAssistant } from './fixtures/stub-assistant.js';

type ClientServer = {
  url: string;
  close: () => Promise<void>;
};

const CLIENT_BUILD = fileURLToPath(new URL('../build/', import.meta.url));
const SERVE_SCRIPT = fileURLToPath(new URL('../bin/serve.mjs', import.meta.url));

let assistant: StubAssistant | undefined;
let clientServer: ClientServer | undefined;

test.afterEach(async () => {
	await assistant?.close();
	assistant = undefined;
	await clientServer?.close();
	clientServer = undefined;
});

test('offline reload renders the app shell and saved connections from IndexedDB (no blank page)', async ({ page }) => {
	clientServer = await startClientServer();
	assistant = await startStubAssistant();
	await addConnection(page, clientServer.url, assistant.url, 'Offline pin');
	await activateServiceWorker(page);
	await stopNetwork();
	await page.reload();

	await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
	await expect(page.getByText('Offline pin', { exact: true }).first()).toBeVisible();
});

test('offline navigation is served by the SW navigateFallback (deep link, then chat shows an error state, not a crash)', async ({ page }) => {
	clientServer = await startClientServer();
	assistant = await startStubAssistant();
	const clientUrl = clientServer.url;
	await addConnection(page, clientUrl, assistant.url, 'Offline chat pin');
	await activateServiceWorker(page);
	await stopNetwork();

	const response = await page.goto(`${clientUrl}/chat`);
	expect(response, 'the SW navigateFallback must serve this navigation').not.toBeNull();
	await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
	const bodyText = await page.evaluate(() => document.body.innerText);
	expect(bodyText.trim().length).toBeGreaterThan(0);
});

async function addConnection(page: Page, clientUrl: string, assistantUrl: string, label: string): Promise<void> {
	await page.goto(clientUrl);
	await page.waitForURL(/\/connections/);
	await page.getByLabel('Label').fill(label);
	await page.getByLabel('URL').fill(assistantUrl);
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
}

async function activateServiceWorker(page: Page): Promise<void> {
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

async function stopNetwork(): Promise<void> {
	await assistant?.close();
	assistant = undefined;
	await clientServer?.close();
	clientServer = undefined;
}

async function startClientServer(): Promise<ClientServer> {
	const port = await availablePort();
	const child = spawn(process.execPath, [SERVE_SCRIPT], {
		env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), OP_CLIENT_DIR: CLIENT_BUILD },
		stdio: 'ignore'
	});
	const url = `http://127.0.0.1:${port}`;

	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`Client server exited with code ${child.exitCode}`);
		try {
			const response = await fetch(url);
			if (response.ok) return { url, close: () => stopChild(child) };
		} catch {
			// Keep polling until the process starts listening.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	await stopChild(child);
	throw new Error('Client server did not become ready');
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, 'exit');
	child.kill('SIGTERM');
	await exited;
}

async function availablePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', resolve);
	});
	const address = probe.address();
	if (!address || typeof address === 'string') throw new Error('Failed to allocate a client test port');
	await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}
