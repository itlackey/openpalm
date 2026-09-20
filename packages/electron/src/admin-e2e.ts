import { app, type BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { adminSnapshot, createAdminWindow, registerAdminIpc, runAdminAction } from './admin-app.js';

type RendererWaitState = { ready: boolean; error: string };

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for the Admin E2E test.`);
	return value;
}

function requiredPort(name: string): number {
	const value = Number(requiredEnvironment(name));
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error(`${name} must be an integer from 1 through 65535.`);
	}
	return value;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function progress(value: string): void {
	process.stdout.write(`[admin-e2e] ${value}\n`);
}

async function waitForAppReady(): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			app.whenReady(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error('Electron did not become ready within 30 seconds.')),
					30_000
				);
			})
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function waitForLoad(window: BrowserWindow): Promise<void> {
	if (!window.webContents.isLoading()) return;
	await new Promise<void>((resolve, reject) => {
		window.webContents.once('did-finish-load', () => resolve());
		window.webContents.once('did-fail-load', (_event, code, description) => {
			reject(new Error(`Admin renderer failed to load (${code}): ${description}`));
		});
	});
}

async function waitForRenderer(
	window: BrowserWindow,
	expression: string,
	description: string,
	timeoutMs = 180_000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = (await window.webContents.executeJavaScript(`(() => {
			const notice = document.querySelector('#notice');
			return {
				ready: Boolean(${expression}),
				error: notice?.classList.contains('error') ? notice.textContent || 'Unknown Admin error' : ''
			};
		})()`)) as RendererWaitState;
		if (state.error) throw new Error(`Admin renderer reported: ${state.error}`);
		if (state.ready) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for ${description}.`);
}

async function capture(window: BrowserWindow, directory: string, name: string): Promise<string> {
	const path = join(directory, name);
	let timeout: NodeJS.Timeout | undefined;
	const image = await Promise.race([
		window.webContents.capturePage(),
		new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => reject(new Error(`Screenshot timed out: ${name}`)), 10_000);
		})
	]).finally(() => {
		if (timeout) clearTimeout(timeout);
	});
	writeFileSync(path, image.toPNG());
	return path;
}

function rpcPayload(text: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(text) as unknown;
		return value !== null && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		for (const line of text.split(/\r?\n/)) {
			if (!line.startsWith('data:')) continue;
			try {
				const value = JSON.parse(line.slice(5).trim()) as unknown;
				if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
					return value as Record<string, unknown>;
				}
			} catch {
				// Continue to the next server-sent event.
			}
		}
	}
	return null;
}

async function guardianRequest(
	url: string,
	body: Record<string, unknown>,
	key?: string
): Promise<{ status: number; text: string; payload: Record<string, unknown> | null }> {
	const headers = new Headers({
		accept: 'application/json, text/event-stream',
		'content-type': 'application/json',
		'mcp-protocol-version': '2025-06-18'
	});
	if (key) headers.set('authorization', `Bearer ${key}`);
	const response = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000)
	});
	const text = await response.text();
	return { status: response.status, text, payload: rpcPayload(text) };
}

function toolNames(payload: Record<string, unknown> | null): string[] {
	const result = payload?.result;
	if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
	const tools = (result as Record<string, unknown>).tools;
	if (!Array.isArray(tools)) return [];
	return tools
		.map((tool) =>
			tool && typeof tool === 'object' && !Array.isArray(tool)
				? (tool as Record<string, unknown>).name
				: undefined
		)
		.filter((name): name is string => typeof name === 'string');
}

async function run(): Promise<Record<string, unknown>> {
	const homeDir = requiredEnvironment('OP_HOME');
	const outputDir = requiredEnvironment('OPENPALM_ADMIN_E2E_OUTPUT');
	const assistantPort = requiredPort('OPENPALM_ADMIN_E2E_ASSISTANT_PORT');
	const guardianPort = requiredPort('OPENPALM_ADMIN_E2E_GUARDIAN_PORT');
	const keepRunning = process.env.OPENPALM_ADMIN_E2E_KEEP_RUNNING === 'true';
	const provider = process.env.OPENPALM_ADMIN_E2E_PROVIDER?.trim() || '';
	const providerKey = process.env.OPENPALM_ADMIN_E2E_PROVIDER_KEY || '';
	assert(Boolean(provider) === Boolean(providerKey), 'Set both E2E provider variables or neither.');
	mkdirSync(outputDir, { recursive: true });
	app.setName('OpenPalm Admin E2E');
	app.setPath('userData', join(outputDir, 'electron-profile'));

	progress(
		`waiting for Electron ${process.versions.electron ?? 'unknown'} (${process.type ?? 'unknown process'})`
	);
	app.once('will-finish-launching', () => progress('Electron will finish launching'));
	app.once('ready', () => progress('Electron ready event received'));
	await waitForAppReady();
	progress('opening the real Admin renderer');
	registerAdminIpc();
	const window = createAdminWindow({ show: true });
	let succeeded = false;
	try {
		await waitForLoad(window);
		await waitForRenderer(
			window,
			"document.querySelector('#install-section')?.hidden === false",
			'the fresh-install screen'
		);
		progress('fresh-install screen loaded');
		const initialScreenshot = await capture(window, outputDir, '01-fresh-install.png');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#install-assistant-port').value = ${JSON.stringify(String(assistantPort))};
			document.querySelector('#install-gateway-port').value = ${JSON.stringify(String(guardianPort))};
			document.querySelector('#install-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice')?.textContent === 'Installing OpenPalm completed.' &&
				[...document.querySelectorAll('#services .service')].some((row) =>
					row.textContent.includes('assistant') && row.textContent.includes('healthy'))`,
			'the Assistant to become healthy'
		);
		progress('Assistant is healthy');
		await window.webContents.executeJavaScript(
			"document.querySelector('#services').closest('section').scrollIntoView()"
		);
		const assistantScreenshot = await capture(window, outputDir, '02-assistant-ready.png');

		await window.webContents.executeJavaScript("document.querySelector('#load-providers').click()");
		await waitForRenderer(
			window,
			`document.querySelector('#notice')?.textContent === 'Loading providers completed.' &&
				document.querySelectorAll('#provider option').length > 0`,
			'OpenCode provider discovery',
			60_000
		);
		const providers = (await window.webContents.executeJavaScript(
			"[...document.querySelectorAll('#provider option')].map((option) => option.value)"
		)) as string[];
		progress(`OpenCode discovered ${providers.length} providers`);

		let readiness: Record<string, unknown> = { attempted: false };
		if (provider && providerKey) {
			assert(providers.includes(provider), `Provider ${provider} was not discovered by OpenCode.`);
			await window.webContents.executeJavaScript(`(() => {
				document.querySelector('#provider').value = ${JSON.stringify(provider)};
				document.querySelector('#provider-key').value = ${JSON.stringify(providerKey)};
				document.querySelector('#provider-form').requestSubmit();
			})()`);
			await waitForRenderer(
				window,
				"document.querySelector('#notice')?.textContent === 'Saving provider key completed.'",
				'provider readiness',
				180_000
			);
			readiness = (await window.webContents.executeJavaScript(
				"JSON.parse(document.querySelector('#provider-result').textContent)"
			)) as Record<string, unknown>;
			assert(readiness.ok === true, `Provider readiness failed: ${JSON.stringify(readiness)}`);
			progress('provider readiness passed');
		}

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#gateway').checked = true;
			document.querySelector('#gateway-port').value = ${JSON.stringify(String(guardianPort))};
			document.querySelector('#config-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice')?.textContent === 'Saving configuration completed.' &&
				[...document.querySelectorAll('#services .service')].some((row) =>
					row.textContent.includes('guardian') && row.textContent.includes('healthy'))`,
			'the Guardian to become healthy'
		);
		progress('Guardian is healthy');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#credential-username').value = 'e2e-reader';
			document.querySelector('#credential-policy').value = 'read';
			document.querySelector('#credential-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice')?.textContent === 'Creating credential completed.' &&
				[...document.querySelectorAll('#credential-action-name option')].some((option) => option.value === 'e2e-reader')`,
			'the read credential to be created'
		);
		progress('read credential created');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#mapping-portal').value = 'discord';
			document.querySelector('#mapping-user').value = '123456789012345678';
			document.querySelector('#mapping-credential').value = 'e2e-reader';
			document.querySelector('#mapping-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice')?.textContent === 'Saving portal user mapping completed.' &&
				document.querySelector('#mappings').textContent.includes('e2e-reader')`,
			'the Discord identity mapping to persist'
		);
		progress('Discord identity mapping persisted');
		await window.webContents.executeJavaScript(
			"document.querySelector('#config-form').closest('section').scrollIntoView()"
		);
		const guardianScreenshot = await capture(window, outputDir, '03-guardian-access.png');

		await window.webContents.executeJavaScript(
			"document.querySelector('[data-action=restart]').click()"
		);
		await waitForRenderer(
			window,
			`document.querySelector('#notice')?.textContent === 'Stack restart completed.' &&
				document.querySelectorAll('#services .service').length === 2 &&
				[...document.querySelectorAll('#services .service')].every((row) => row.textContent.includes('healthy'))`,
			'a healthy stack restart'
		);
		progress('stack restart passed');

		const reloaded = new Promise<void>((resolve, reject) => {
			window.webContents.once('did-finish-load', () => resolve());
			window.webContents.once('did-fail-load', (_event, code, description) => {
				reject(new Error(`Admin renderer failed to reload (${code}): ${description}`));
			});
		});
		window.webContents.reload();
		await reloaded;
		await waitForRenderer(
			window,
			`document.querySelector('#install-section')?.hidden === true &&
				document.querySelector('#assistant-port')?.value === ${JSON.stringify(String(assistantPort))} &&
				document.querySelector('#gateway-port')?.value === ${JSON.stringify(String(guardianPort))} &&
				document.querySelector('#mappings')?.textContent.includes('e2e-reader')`,
			'persistent configuration after renderer reload'
		);
		progress('renderer reload preserved configuration');

		const guardianUrl = `http://127.0.0.1:${guardianPort}`;
		const health = await fetch(`${guardianUrl}/health`, { signal: AbortSignal.timeout(5_000) });
		assert(health.ok, `Guardian health returned HTTP ${health.status}.`);
		const initialize = {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'openpalm-admin-e2e', version: '1' }
			}
		};
		const unauthorized = await guardianRequest(`${guardianUrl}/mcp`, initialize);
		assert(unauthorized.status === 401, `Unauthenticated MCP returned ${unauthorized.status}.`);
		const key = readFileSync(
			join(homeDir, 'state', 'credentials', 'e2e-reader', 'key'),
			'utf8'
		).trim();
		const authorized = await guardianRequest(`${guardianUrl}/mcp`, initialize, key);
		assert(
			authorized.status === 200,
			`Authenticated MCP initialize returned ${authorized.status}.`
		);
		const listed = await guardianRequest(
			`${guardianUrl}/mcp`,
			{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
			key
		);
		assert(listed.status === 200, `Authenticated MCP tools/list returned ${listed.status}.`);
		const tools = toolNames(listed.payload);
		assert(
			tools.includes('openpalm.workspace.read'),
			'The read policy did not expose workspace.read.'
		);
		assert(
			!tools.includes('openpalm.session.delete'),
			'The read policy exposed full-only session.delete.'
		);
		progress('Guardian authentication and read-policy MCP catalog passed');

		const finalSnapshot = await adminSnapshot();
		assert(finalSnapshot.config.gateway.enabled, 'Guardian configuration was not persisted.');
		assert(
			finalSnapshot.portalMappings.discord?.users['123456789012345678'] === 'e2e-reader',
			'Discord credential mapping was not persisted.'
		);
		succeeded = true;
		return {
			ok: true,
			homeDir,
			projectName: process.env.OP_PROJECT_NAME || 'openpalm',
			assistantPort,
			guardianPort,
			services: finalSnapshot.services,
			providersDiscovered: providers.length,
			providerReadiness: readiness,
			credential: { username: 'e2e-reader', policy: 'read' },
			portalMapping: { portal: 'discord', user: '123456789012345678' },
			guardian: {
				healthStatus: health.status,
				unauthenticatedStatus: unauthorized.status,
				authenticatedInitializeStatus: authorized.status,
				toolsListStatus: listed.status,
				toolCount: tools.length
			},
			screenshots: [initialScreenshot, assistantScreenshot, guardianScreenshot],
			keptRunning: keepRunning
		};
	} finally {
		if (!keepRunning || !succeeded) {
			try {
				await runAdminAction('stop');
			} catch {
				// The runner performs a targeted Compose cleanup if setup failed early.
			}
		}
		window.destroy();
	}
}

async function main(): Promise<void> {
	const outputDir = process.env.OPENPALM_ADMIN_E2E_OUTPUT?.trim();
	try {
		const report = await run();
		if (outputDir)
			writeFileSync(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		app.exit(0);
	} catch (error) {
		const failure = { ok: false, error: message(error) };
		if (outputDir) {
			mkdirSync(outputDir, { recursive: true });
			writeFileSync(join(outputDir, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
		}
		process.stderr.write(`Admin E2E failed: ${failure.error}\n`);
		app.exit(1);
	}
}

void main();
