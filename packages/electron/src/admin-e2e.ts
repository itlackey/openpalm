import { app, dialog, shell, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	defaultStackConfig,
	markInstalled,
	testAssistantReadiness,
	updateEnvFile,
	stackEnvFile
} from '@openpalm/lib';
import { installFromAdmin } from './admin-domain.js';

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
	timeoutMs = 180_000,
	allowError = false
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (window.webContents.isLoading()) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			continue;
		}
		const state = (await window.webContents.executeJavaScript(`(() => {
			const notice = document.querySelector('#notice');
			return {
				ready: Boolean(${expression}),
				error: notice && !notice.hidden && notice.classList.contains('error') ? notice.textContent || 'Unknown Admin error' : ''
			};
		})()`)) as RendererWaitState;
		if (state.error && !allowError) throw new Error(`Admin renderer reported: ${state.error}`);
		if (state.ready) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for ${description}.`);
}

async function capture(window: BrowserWindow, directory: string, name: string): Promise<string> {
	const path = join(directory, name);
	await window.webContents.executeJavaScript(
		'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
	);
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

async function assertRenderedFloor(window: BrowserWindow, label: string): Promise<void> {
	// Exercise real keyboard modality; focus-visible should not decorate mouse clicks.
	window.focus();
	window.webContents.focus();
	window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
	window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
	await window.webContents.executeJavaScript(
		'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
	);
	const result = (await window.webContents.executeJavaScript(`(() => {
		const visible = (element) => {
			const modal = document.querySelector('dialog[open]');
			if (modal && !modal.contains(element)) return false;
			if (element.tagName !== 'SUMMARY' && element.closest('details:not([open])')) return false;
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
		};
		const controls = [...document.querySelectorAll('button,input,select,summary')].filter(visible);
		const undersized = controls
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return { tag: element.tagName, id: element.id, width: rect.width, height: rect.height };
			})
			.filter((item) => item.width < 24 || item.height < 24);
		const focusTarget = document.activeElement;
		const focusStyle = focusTarget ? getComputedStyle(focusTarget) : null;
		return {
			overflow: document.documentElement.scrollWidth - window.innerWidth,
			undersized,
			focus: focusStyle ? { id: focusTarget.id, tag: focusTarget.tagName, style: focusStyle.outlineStyle, width: focusStyle.outlineWidth } : null
		};
	})()`)) as {
		overflow: number;
		undersized: Array<{ tag: string; id: string; width: number; height: number }>;
		focus: { style: string; width: string } | null;
	};
	assert(result.overflow <= 1, `${label} has ${result.overflow}px of horizontal overflow.`);
	assert(
		result.undersized.length === 0,
		`${label} has undersized controls: ${JSON.stringify(result.undersized)}`
	);
	assert(
		result.focus !== null && result.focus.style !== 'none' && result.focus.width !== '0px',
		`${label} does not expose a visible focus outline: ${JSON.stringify(result.focus)}`
	);
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
	key?: string,
	timeoutMs = 15_000
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
		signal: AbortSignal.timeout(timeoutMs)
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
	const keyFile = process.env.OPENPALM_ADMIN_E2E_PROVIDER_KEY_FILE;
	const providerKey = keyFile
		? readFileSync(keyFile, 'utf8').trim()
		: process.env.OPENPALM_ADMIN_E2E_PROVIDER_KEY || '';
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
	window.setTitle('OpenPalm Admin — automated UI test');
	window.on('page-title-updated', (event) => event.preventDefault());
	let succeeded = false;
	try {
		await waitForLoad(window);
		await waitForRenderer(
			window,
			"document.body.dataset.phase === 'welcome'",
			'the instance welcome screen'
		);
		assert(
			!existsSync(join(homeDir, 'state')),
			'Welcome seeded the default home before selection.'
		);
		await assertRenderedFloor(window, 'instance welcome');
		const welcomeScreenshot = await capture(window, outputDir, '00-instance-welcome.png');
		window.setContentSize(640, 540);
		await assertRenderedFloor(window, 'narrow instance welcome');
		const narrowWelcomeScreenshot = await capture(
			window,
			outputDir,
			'00b-instance-welcome-narrow.png'
		);
		window.setContentSize(1120, 780);
		const originalPicker = dialog.showOpenDialog;
		const otherHome = join(outputDir, 'other-empty-instance');
		const incompatibleHome = join(outputDir, 'legacy-instance');
		mkdirSync(otherHome);
		mkdirSync(incompatibleHome);
		writeFileSync(join(incompatibleHome, 'user-data'), 'preserve this');
		try {
			dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
			await window.webContents.executeJavaScript(
				"document.querySelector('#choose-instance').click()"
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert(
				await window.webContents.executeJavaScript("document.body.dataset.phase === 'welcome'"),
				'Cancelled folder selection left welcome.'
			);
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [incompatibleHome] });
			await window.webContents.executeJavaScript(
				"document.querySelector('#choose-instance').click()"
			);
			await waitForRenderer(
				window,
				"document.body.dataset.busy === 'false' && document.querySelector('#notice-message').textContent.includes('not an OpenPalm 0.14')",
				'incompatible folder rejection',
				10_000,
				true
			);
			assert(!existsSync(join(incompatibleHome, 'state')), 'Invalid folder was modified.');
			await window.webContents.executeJavaScript(
				"document.querySelector('#dismiss-notice').click()"
			);
			await waitForRenderer(
				window,
				"document.querySelector('#notice').hidden",
				'the dismissed folder error',
				10_000
			);
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [otherHome] });
			await window.webContents.executeJavaScript(
				"document.querySelector('#choose-instance').click()"
			);
			await waitForRenderer(
				window,
				`document.body.dataset.phase === 'not_installed' && document.querySelector('#install-home').textContent === ${JSON.stringify(otherHome)}`,
				'the selected empty folder'
			);
			await window.webContents.executeJavaScript(
				"document.querySelector('#install-section [data-instance-switch]').click()"
			);
			await waitForRenderer(
				window,
				"document.body.dataset.phase === 'welcome' && document.querySelector('#open-recent-instance').textContent === 'Open previous instance'",
				'recent-instance welcome'
			);
			const preferences = readFileSync(join(app.getPath('userData'), 'instances.json'), 'utf8');
			assert(preferences.includes(otherHome), 'Recent instance was not persisted.');
			await window.webContents.executeJavaScript(
				"document.querySelector('#open-default-instance').click()"
			);
		} finally {
			dialog.showOpenDialog = originalPicker;
		}
		await waitForRenderer(
			window,
			"document.querySelector('#install-section')?.hidden === false && document.querySelector('#install')?.disabled === false",
			'the fresh-install screen'
		);
		progress('fresh-install screen loaded');
		const initialScreenshot = await capture(window, outputDir, '01-fresh-install.png');
		const advancedHidden = (await window.webContents.executeJavaScript(
			"document.querySelector('#install-assistant-port').closest('details').open === false"
		)) as boolean;
		assert(advancedHidden, 'Fresh setup exposed advanced ports by default.');
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('#install').getBoundingClientRect().bottom <= innerHeight"
			),
			'Install button requires scrolling at the default window size.'
		);
		await assertRenderedFloor(window, 'fresh setup');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#install-assistant-port').value = ${JSON.stringify(String(assistantPort))};
			document.querySelector('#install-gateway-port').value = ${JSON.stringify(String(guardianPort))};
				document.querySelector('#install-form').requestSubmit();
			})()`);
		const installLocked = (await window.webContents.executeJavaScript(
			"document.body.dataset.busy === 'true' && document.querySelector('#install').disabled"
		)) as boolean;
		assert(installLocked, 'Install did not lock duplicate operations while pending.');
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'OpenPalm is installed. Next, connect your AI provider.' &&
					document.querySelector('#view-provider')?.hidden === false &&
					getComputedStyle(document.querySelector('#primary-nav')).display === 'none' &&
					[...document.querySelectorAll('#services .service')].some((row) =>
						row.textContent.includes('assistant') && row.textContent.includes('Running normally'))`,
			'the Assistant to become healthy'
		);
		progress('Assistant is healthy and provider setup is active');
		const assistantScreenshot = await capture(window, outputDir, '02-provider-required.png');
		await assertRenderedFloor(window, 'provider setup');

		await runAdminAction('stop');
		await window.webContents.executeJavaScript("document.querySelector('#refresh').click()");
		await waitForRenderer(
			window,
			`document.querySelector('#setup-recovery')?.hidden === false &&
					document.querySelector('#recovery-assistant-port')?.value === ${JSON.stringify(String(assistantPort))}`,
			'the visible startup recovery controls'
		);
		const recoveryScreenshot = await capture(window, outputDir, '02b-startup-recovery.png');
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('#provider-connection').hidden && !/running locally/.test(document.querySelector('#setup-runtime').textContent)"
			),
			'Recovery contradicts the agent status.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('#recovery-form').requestSubmit()"
		);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'OpenPalm started. Now connect your AI provider.' &&
					document.querySelector('#setup-recovery')?.hidden === true &&
					[...document.querySelectorAll('#services .service')].some((row) => row.textContent.includes('Running normally'))`,
			'the Assistant to recover through setup'
		);
		progress('visible startup recovery passed');
		window.setSize(640, 720);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await assertRenderedFloor(window, 'provider setup at minimum width');
		window.webContents.setZoomFactor(2);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await assertRenderedFloor(window, 'provider setup at 200% zoom');
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('.sidebar').getBoundingClientRect().height < 70 && document.querySelector('#provider-connection').getBoundingClientRect().top < innerHeight * 0.65"
			),
			'Setup chrome crowds out the account form at 200% zoom.'
		);
		const reflowScreenshot = await capture(window, outputDir, '03-provider-reflow.png');
		window.webContents.setZoomFactor(1);
		window.setSize(1120, 780);
		await new Promise((resolve) => setTimeout(resolve, 300));

		await window.webContents.executeJavaScript("document.querySelector('#load-providers').click()");
		await waitForRenderer(
			window,
			"document.querySelector('#provider-result')?.value.trim().startsWith('[')",
			'OpenCode provider discovery',
			60_000
		);
		const providerCatalog = (await window.webContents.executeJavaScript(
			"JSON.parse(document.querySelector('#provider-result').value)"
		)) as Array<Record<string, unknown>>;
		progress(`OpenCode discovered ${providerCatalog.length} providers`);
		// Discovery can launch an automatic existing-sign-in check. Wait for it before
		// submitting another operation through the deliberately locked setup form.
		await waitForRenderer(
			window,
			"document.body.dataset.busy !== 'true'",
			'the existing-sign-in check to finish',
			180_000,
			true
		);

		let readiness: Record<string, unknown> = { attempted: false };
		let readyScreenshot: string | undefined;
		if (provider && providerKey) {
			await window.webContents.executeJavaScript(`(() => {
				document.querySelector('#provider-search').value = ${JSON.stringify(provider)};
				document.querySelector('#provider-search').dispatchEvent(new Event('input', { bubbles: true }));
			})()`);
			const filteredProviders = (await window.webContents.executeJavaScript(
				"[...document.querySelectorAll('#provider option')].map((option) => option.value)"
			)) as string[];
			assert(
				filteredProviders.includes(provider),
				`Provider ${provider} was not discovered by OpenCode.`
			);
			await window.webContents.executeJavaScript(`(() => {
				document.querySelector('#provider').value = ${JSON.stringify(provider)};
				document.querySelector('#provider').dispatchEvent(new Event('change', { bubbles: true }));
				const apiMethod = [...document.querySelectorAll('#provider-method option')].find((option) => /api/i.test(option.textContent));
				if (apiMethod) {
					document.querySelector('#provider-method').value = apiMethod.value;
					document.querySelector('#provider-method').dispatchEvent(new Event('change', { bubbles: true }));
				}
				document.querySelector('#provider-key').value = ${JSON.stringify(providerKey)};
				document.querySelector('#provider-form').requestSubmit();
			})()`);
			await waitForRenderer(
				window,
				`document.querySelector('#notice-message')?.textContent === 'Provider verified. Your personal agent is ready.' &&
						document.querySelector('#view-overview')?.hidden === false`,
				'provider readiness',
				180_000
			);
			readiness = (await window.webContents.executeJavaScript(
				"JSON.parse(document.querySelector('#provider-result').value)"
			)) as Record<string, unknown>;
			assert(readiness.ok === true, `Provider readiness failed: ${JSON.stringify(readiness)}`);
			progress('provider readiness passed');
			readyScreenshot = await capture(window, outputDir, '04-agent-ready.png');
		} else {
			await window.webContents.executeJavaScript(
				"if (!document.querySelector('#test-provider').disabled) document.querySelector('#test-provider').click()"
			);
			await waitForRenderer(
				window,
				`document.querySelector('#notice')?.classList.contains('error') &&
						document.querySelector('#provider-status')?.classList.contains('error') &&
						document.querySelector('#view-provider')?.hidden === false`,
				'a truthful provider-required error',
				60_000,
				true
			);
			readiness = (await window.webContents.executeJavaScript(
				"JSON.parse(document.querySelector('#provider-result').value)"
			)) as Record<string, unknown>;
			assert(
				readiness.ok === false,
				`Expected provider readiness to fail: ${JSON.stringify(readiness)}`
			);
			progress('provider failure remained an incomplete setup error');
			markInstalled(homeDir);
			await window.webContents.executeJavaScript("document.querySelector('#refresh').click()");
			await waitForRenderer(
				window,
				`document.querySelector('#view-overview')?.hidden === false &&
						document.querySelector('#primary-nav')?.hidden === false &&
						document.querySelector('#refresh')?.textContent === 'Status up to date'`,
				'the isolated management UI fixture',
				60_000,
				true
			);
			progress('entered ready management UI through an explicit test-only fixture');
		}

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#dismiss-notice').click();
			document.querySelector('[data-view=connections]').click();
			document.querySelector('[data-remote-enable=codex]').click();
			if (!document.querySelector('#remote-dialog').open) throw new Error('Remote setup dialog did not open.');
			if (document.querySelector('#remote-trust').checked) throw new Error('Native trust was preaccepted.');
			if (document.querySelector('#remote-sandbox-field').hidden) throw new Error('Codex sandbox choice is missing.');
			if (document.querySelector('#remote-advanced').open || document.querySelector('#remote-sandbox').value !== 'workspace-write') throw new Error('Safe sandbox default is not tucked into Advanced settings.');
			if (!document.querySelector('#remote-send').hidden) throw new Error('An irrelevant native answer control is exposed before setup.');
			if ([...document.querySelector('#remote-sandbox').options].some(option => /danger|bypass/i.test(option.value))) throw new Error('Sandbox bypass is offered.');
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#remote-recall-status')?.textContent === 'Approval needed' && !document.querySelector('#remote-recall').disabled`,
			'native AKM hook review',
			60_000,
			!provider
		);
		assert(
			await window.webContents.executeJavaScript(
				"!document.querySelector('#remote-recall').checked && !document.querySelector('#remote-recall-field').hidden"
			),
			'Recall approval was missing or preaccepted in Codex setup.'
		);
		await assertRenderedFloor(window, 'native remote setup dialog');
		const nativeRemoteScreenshot = await capture(window, outputDir, '04-native-remote-setup.png');
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#remote-cancel').click();
			document.querySelector('[data-remote-enable=claude]').click();
			if (!document.querySelector('#remote-sandbox-field').hidden) throw new Error('Codex-only sandbox option appears for Claude.');
			document.querySelector('#remote-cancel').click();
		})()`);
		progress(
			'native remote setup opens from Admin with explicit trust and safe sandbox choices; no subscription login was performed'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-codex-recall-review]').click()"
		);
		await waitForRenderer(
			window,
			"!document.querySelector('#remote-recall').disabled && document.querySelector('#remote-recall-status').textContent === 'Approval needed'",
			'standalone native recall review',
			60_000,
			!provider
		);
		await window.webContents.executeJavaScript(`(async () => {
			const review = await window.openpalmAdmin.codexRecall({action:'review'});
			let rejected = false;
			try { await window.openpalmAdmin.codexRecall({action:'approve',digest:review.digest}); } catch { rejected = true; }
			if (!rejected) throw new Error('Recall approval accepted without explicit consent.');
			document.querySelector('#remote-recall').click();
			document.querySelector('#remote-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			"document.querySelector('#remote-stage').textContent.includes('Knowledge recall is ready') && document.querySelector('#codex-recall-status').textContent === 'Ready'",
			'native recall approval saved',
			60_000,
			!provider
		);
		const recallScreenshot = await capture(window, outputDir, '04a-codex-knowledge-recall.png');
		await window.webContents.executeJavaScript("document.querySelector('#remote-cancel').click()");
		await runAdminAction('restart');
		await window.webContents.executeJavaScript("document.querySelector('#refresh').click()");
		await waitForRenderer(
			window,
			"document.querySelector('#codex-recall-status').textContent === 'Ready' && document.querySelector('#refresh').textContent === 'Status up to date'",
			'recall approval after container recreation',
			60_000,
			!provider
		);
		const recallSnapshot = await adminSnapshot();
		assert(
			recallSnapshot.codexRecall?.status === 'ready' &&
				recallSnapshot.config.assistant.codexRemote === false,
			'Recall did not persist independently from remote startup.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-codex-recall-review]').click()"
		);
		await waitForRenderer(
			window,
			"!document.querySelector('#remote-recall-disable').hidden && !document.querySelector('#remote-recall').disabled",
			'recall off control',
			60_000,
			!provider
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('#remote-recall-disable').click()"
		);
		await waitForRenderer(
			window,
			"document.querySelector('#remote-recall-status').textContent === 'Installed' && !document.querySelector('#remote-recall').checked && document.querySelector('#codex-recall-status').textContent === 'Installed'",
			'recall opt-out saved',
			60_000,
			!provider
		);
		await window.webContents.executeJavaScript("document.querySelector('#remote-cancel').click()");
		progress(
			'native AKM approval required consent, persisted across recreation, and opted out without remote startup or vendor login'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=overview]').click()"
		);
		const overviewScreenshot = await capture(window, outputDir, '04b-overview.png');
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('#view-title').focus(); getComputedStyle(document.querySelector('#view-title')).outlineStyle === 'none'"
			),
			'Programmatically focused headings have a decorative outline.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=connections]').click()"
		);
		const connectionsScreenshot = await capture(window, outputDir, '04c-connections.png');
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=backup]').click()"
		);
		await assertRenderedFloor(window, 'backup and restore');
		const backupScreenshot = await capture(window, outputDir, '04d-backup.png');
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=diagnostics]').click()"
		);
		await assertRenderedFloor(window, 'troubleshooting');
		const troubleshootingScreenshot = await capture(window, outputDir, '04e-troubleshooting.png');
		assert(
			await window.webContents.executeJavaScript(`(() => {
				const link = document.querySelector('#assistant-url-detail');
				return link?.tagName === 'A' && link.href === 'http://127.0.0.1:${assistantPort}/' &&
					link.tabIndex === 0 &&
					document.querySelector('label[for="gateway-bind"]')?.textContent.includes('Guardian MCP') &&
					document.querySelector('#guardian-mcp-url-detail')?.textContent === 'http://127.0.0.1:${guardianPort}/mcp' &&
					document.querySelector('#guardian-health-url-detail')?.textContent === 'http://127.0.0.1:${guardianPort}/health';
			})()`),
			'Network details omitted clear MCP endpoints or a keyboard-accessible OpenCode link.'
		);
		const openedUrls: string[] = [];
		const originalOpenExternal = shell.openExternal;
		const adminPageUrl = window.webContents.getURL();
		// Exercise a normal link through Electron's existing window opener;
		// intercept only the OS browser launch.
		shell.openExternal = async (url) => {
			openedUrls.push(url);
		};
		const waitForBrowserOpen = async (count: number) => {
			const deadline = Date.now() + 10_000;
			while (openedUrls.length < count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert(openedUrls.length === count, 'OpenCode link did not dispatch to the browser.');
		};
		try {
			await window.webContents.executeJavaScript(
				"document.querySelector('#assistant-url-detail').focus()"
			);
			window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
			window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
			await waitForBrowserOpen(1);
			await window.webContents.executeJavaScript(
				"document.querySelector('#assistant-url-detail').click()"
			);
			await waitForBrowserOpen(2);
			assert(
				openedUrls.length === 2 &&
					openedUrls.every((url) => url === `http://127.0.0.1:${assistantPort}/`),
				'OpenCode link did not open the displayed address.'
			);
			assert(
				await window.webContents.executeJavaScript(
					"window.openpalmAdmin.openExternal('file:///tmp/private').then(() => false, () => true)"
				),
				'Browser dispatch accepted a non-web URL.'
			);
			assert(
				window.webContents.getURL() === adminPageUrl,
				'OpenCode link navigated the Admin renderer.'
			);
		} finally {
			shell.openExternal = originalOpenExternal;
		}
		progress('MCP details and normal OpenCode link verified with real keyboard/click events');
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=overview]').click()"
		);

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#agent-timezone').value = 'Europe/London';
			document.querySelector('#automatic-memory').checked = false;
			document.querySelector('#agent-timezone').dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('#preferences-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'Agent preferences saved and OpenPalm restarted.' &&
				document.querySelector('#agent-timezone')?.value === 'Europe/London' &&
				document.querySelector('#automatic-memory')?.checked === false`,
			'agent timezone and memory preferences to be applied'
		);
		progress('timezone and automatic-memory preferences saved through the real UI');

		await window.webContents.executeJavaScript(
			"document.querySelector('[data-client-target=opencode]').click()"
		);
		await waitForRenderer(
			window,
			`document.querySelector('#view-connections')?.hidden === false &&
					document.querySelector('#client-opencode')?.hidden === false &&
					document.querySelector('#direct-url')?.textContent.startsWith('http://') &&
					document.querySelector('#direct-username')?.textContent === 'opencode'`,
			'the complete OpenCode connection recipe'
		);
		await window.webContents.executeJavaScript(`(() => {
			window.confirm = () => true;
			document.querySelector('#load-direct-password').click();
		})()`);
		await waitForRenderer(
			window,
			"document.querySelector('#direct-password')?.value.length >= 32",
			'the explicit OpenCode password reveal'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-client-setup=claude]').click()"
		);
		const claudeRecipe = (await window.webContents.executeJavaScript(`(() => ({
			url: document.querySelector('#claude-url')?.textContent,
			credential: document.querySelector('#claude-credential')?.value,
			extension: document.querySelector('#install-claude-extension')?.dataset.url
		}))()`)) as { url?: string; credential?: string; extension?: string };
		assert(claudeRecipe.url?.endsWith('/mcp'), 'Claude recipe omitted the MCP endpoint.');
		assert(claudeRecipe.credential === 'owner', 'Claude recipe omitted its access identity.');
		assert(claudeRecipe.extension?.endsWith('.mcpb'), 'Claude recipe omitted its extension.');
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-client-setup=mcp]').click()"
		);
		assert(
			(await window.webContents.executeJavaScript(
				"document.querySelector('#mcp-url')?.textContent.endsWith('/mcp') && document.querySelector('#mcp-credential')?.value === 'owner'"
			)) as boolean,
			'The generic MCP recipe was incomplete.'
		);
		progress('all three complete client connection recipes rendered');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#discord').checked = true;
			document.querySelector('#discord').dispatchEvent(new Event('change', { bubbles: true }));
			document.querySelector('#connections-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice')?.classList.contains('error') &&
					document.querySelector('#discord-access-disclosure')?.open === true &&
					document.activeElement?.id === 'discord-users'`,
			'the Discord access-scope guidance',
			10_000,
			true
		);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#discord-users').value = '123456789012345678';
			document.querySelector('#discord-users').dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('#connections-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'Store a Discord bot token before enabling Discord.' &&
					document.querySelector('#token-portal')?.value === 'discord' &&
					document.activeElement?.id === 'bot-token'`,
			'the Discord private-token guidance',
			10_000,
			true
		);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#discord').checked = false;
			document.querySelector('#discord-users').value = '';
			document.querySelector('#discord').dispatchEvent(new Event('change', { bubbles: true }));
		})()`);
		progress('portal setup errors opened and focused the required controls');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#gateway').checked = true;
			document.querySelector('#gateway').dispatchEvent(new Event('change', { bubbles: true }));
			document.querySelector('#connections-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'Connections saved and OpenPalm is running.' &&
					[...document.querySelectorAll('#services .service')].some((row) =>
						row.textContent.includes('guardian') && row.textContent.includes('Running normally'))`,
			'the Guardian to become healthy'
		);
		progress('Guardian is healthy');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('[data-view=access]').click();
			document.querySelector('#credential-username').value = 'e2e-reader';
			document.querySelector('#credential-policy').value = 'read';
			document.querySelector('#credential-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent.includes('Access for e2e-reader created.') &&
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
			`document.querySelector('#notice-message')?.textContent === 'Individual user access saved.' &&
					document.querySelector('#mappings').textContent.includes('e2e-reader')`,
			'the Discord identity mapping to persist'
		);
		progress('Discord identity mapping persisted');
		const guardianScreenshot = await capture(window, outputDir, '05-people-access.png');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('[data-view=overview]').click();
			document.querySelector('[data-action=restart]').click();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'OpenPalm restarted.' &&
					document.querySelectorAll('#services .service').length === 2 &&
					[...document.querySelectorAll('#services .service')].every((row) => row.textContent.includes('Running normally'))`,
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
					document.querySelector('#app-shell')?.hidden === false &&
					document.querySelector('#assistant-port')?.value === ${JSON.stringify(String(assistantPort))} &&
				document.querySelector('#gateway-port')?.value === ${JSON.stringify(String(guardianPort))} &&
				document.querySelector('#agent-timezone')?.value === 'Europe/London' &&
				document.querySelector('#automatic-memory')?.checked === false &&
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
		let providerRuntime: Record<string, unknown> | undefined;
		if (provider) {
			const native = await testAssistantReadiness(homeDir);
			assert(native.ok, 'The installed default provider failed a real request after restart.');
			let response = await guardianRequest(
				`${guardianUrl}/mcp`,
				{
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: {
						name: 'openpalm.agent.run',
						arguments: {
							message: 'Reply with exactly OPENPALM_MCP_READY. Do not use any tools.',
							waitMs: 30_000
						}
					}
				},
				key,
				45_000
			);
			const output = (rpc: typeof response): Record<string, unknown> => {
				assert(rpc.status === 200 && !rpc.payload?.error, 'The live MCP request failed.');
				const result = rpc.payload?.result as Record<string, unknown> | undefined;
				assert(result && !result.isError, 'Guardian rejected the live MCP request.');
				return result.structuredContent as Record<string, unknown>;
			};
			let result = output(response);
			const deadline = Date.now() + 120_000;
			while (result.status === 'running' && Date.now() < deadline) {
				response = await guardianRequest(
					`${guardianUrl}/mcp`,
					{
						jsonrpc: '2.0',
						id: 4,
						method: 'tools/call',
						params: {
							name: 'openpalm.job.get',
							arguments: { job: result.job, waitMs: 30_000 }
						}
					},
					key,
					45_000
				);
				result = output(response);
			}
			assert(
				result.status === 'completed' && String(result.text).includes('OPENPALM_MCP_READY'),
				'The installed agent did not complete a real MCP response after restart.'
			);
			providerRuntime = {
				nativeDefaultVerified: true,
				provider: native.provider,
				model: native.model,
				mcpAgentVerified: true
			};
			progress('installed default provider and live MCP agent response passed after restart');
		}

		const savedPreferences = await adminSnapshot();
		assert(
			savedPreferences.config.assistant.timezone === 'Europe/London' &&
				savedPreferences.config.assistant.automaticMemory === false,
			'Agent preferences were not persisted after restart and renderer reload.'
		);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('[data-view=overview]').click();
			document.querySelector('#automatic-memory').checked = true;
			document.querySelector('#automatic-memory').dispatchEvent(new Event('change', { bubbles: true }));
			document.querySelector('#preferences-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'Agent preferences saved and OpenPalm restarted.' &&
				document.querySelector('#automatic-memory')?.checked === true &&
				[...document.querySelectorAll('#services .service')].every((row) => row.textContent.includes('Running normally'))`,
			'automatic memory to be restored for runtime acceptance'
		);
		progress('automatic memory re-enabled after verifying the persisted opt-out');
		const finalSnapshot = await adminSnapshot();
		assert(finalSnapshot.config.gateway.enabled, 'Guardian configuration was not persisted.');
		assert(finalSnapshot.config.assistant.automaticMemory, 'Automatic memory was not restored.');
		assert(
			finalSnapshot.portalMappings.discord?.users['123456789012345678'] === 'e2e-reader',
			'Discord credential mapping was not persisted.'
		);
		// A second valid, stopped fixture proves that every operation uses the
		// selected folder, even though process.env.OP_HOME still names the first.
		await installFromAdmin(defaultStackConfig(), otherHome);
		updateEnvFile(stackEnvFile(otherHome), {
			OP_PROJECT_NAME: `${process.env.OP_PROJECT_NAME}-other`
		});
		markInstalled(otherHome);
		const originalConfig = readFileSync(join(homeDir, 'state', 'stack.json'), 'utf8');
		const managedWindowSize = window.getSize();
		await window.webContents.executeJavaScript(`(() => {
			window.confirm = () => true;
			document.querySelector('#provider-key').value = 'transient-key-must-not-survive';
			document.querySelector('#credential-key').value = 'transient-credential-must-not-survive';
			document.querySelector('.sidebar [data-instance-switch]').click();
		})()`);
		await waitForRenderer(
			window,
			"document.body.dataset.phase === 'welcome'",
			'instance switching from management'
		);
		assert(
			window.getSize().join('x') === managedWindowSize.join('x'),
			'Returning to welcome resized Admin.'
		);
		const recentScreenshot = await capture(window, outputDir, '06-recent-instances.png');
		window.setContentSize(640, 540);
		await assertRenderedFloor(window, 'narrow recent-instance list');
		window.setSize(managedWindowSize[0], managedWindowSize[1]);
		await window.webContents.executeJavaScript(
			"document.querySelector('#recent-instances button').click()"
		);
		await waitForRenderer(
			window,
			`document.body.dataset.phase === 'ready' && document.querySelector('#home').textContent === ${JSON.stringify(otherHome)}`,
			'the second valid instance'
		);
		assert(
			window.getSize().join('x') === managedWindowSize.join('x'),
			'Opening another instance resized Admin.'
		);
		assert(
			await window.webContents.executeJavaScript(`(() => {
			return !document.querySelector('#provider-key').value && !document.querySelector('#credential-key').value;
		})()`),
			'Transient keys survived the instance switch.'
		);
		await window.webContents.executeJavaScript(
			"window.openpalmAdmin.credential({ action: 'create', username: 'other-instance-only', policy: 'read' })"
		);
		assert(
			readFileSync(join(homeDir, 'state', 'stack.json'), 'utf8') === originalConfig,
			'A second-instance operation changed the first instance.'
		);
		assert(
			readFileSync(join(otherHome, 'state', 'stack.json'), 'utf8').includes('other-instance-only'),
			'The credential was not written to the selected instance.'
		);
		assert(
			await window.webContents.executeJavaScript(
				"window.openpalmAdmin.providerOAuthFinish({provider:'openai',method:0}).then(() => false, () => true)"
			),
			'A stale sign-in step was accepted after switching.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('.sidebar [data-instance-switch]').click()"
		);
		await waitForRenderer(
			window,
			"document.body.dataset.phase === 'welcome'",
			'returning to the instance list'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('#open-default-instance').click()"
		);
		await waitForRenderer(
			window,
			`document.body.dataset.phase === 'ready' && document.querySelector('#home').textContent === ${JSON.stringify(homeDir)}`,
			'returning to the original instance'
		);
		assert(
			(await adminSnapshot()).services.every((service) => service.state === 'running'),
			'Switching stopped the original stack.'
		);
		assert(process.env.OP_HOME === homeDir, 'Instance selection mutated the global OP_HOME.');
		assert(
			window.getSize().join('x') === managedWindowSize.join('x'),
			'Returning to the original instance resized Admin.'
		);
		progress('two-instance isolation, renderer key reset and stale sign-in rejection verified');
		succeeded = true;
		return {
			ok: true,
			homeDir,
			projectName: process.env.OP_PROJECT_NAME || 'openpalm',
			assistantPort,
			guardianPort,
			services: finalSnapshot.services,
			providersDiscovered: providerCatalog.length,
			providerReadiness: readiness,
			...(providerRuntime ? { providerRuntime } : {}),
			visibleSetupJourneyComplete: Boolean(provider && providerKey),
			managementUiFixtureUsed: !provider,
			startupRecoveryVerified: true,
			instanceWelcomeVerified: {
				defaultOneClick: true,
				folderSelectionAndCancellation: true,
				invalidFolderPreserved: true,
				recentFoldersPersisted: true,
				switchReloadsRenderer: true,
				twoInstanceIsolation: true,
				transientKeysCleared: true,
				staleSignInRejected: true,
				windowSizeStable: true
			},
			nativeRemoteSetup: {
				dialogVerified: true,
				explicitTrust: true,
				sandboxChoices: ['workspace-write', 'read-only'],
				subscriptionLoginVerified: false
			},
			codexRecall: {
				explicitConsent: true,
				nativeApproval: true,
				restartPersistence: true,
				optOut: true,
				noRemoteStartup: true
			},
			agentPreferencesVerified: {
				timezone: 'Europe/London',
				memoryOptOutPersisted: true,
				automaticMemoryRestored: true
			},
			connectionRecipesVerified: ['opencode', 'claude', 'mcp'],
			networkDetailsVerified: {
				mcpApiLabels: true,
				fullMcpAndHealthUrls: true,
				openCodeKeyboardAndClick: true,
				standardBrowserLink: true,
				rendererNavigationPrevented: true
			},
			credential: { username: 'e2e-reader', policy: 'read' },
			portalMapping: { portal: 'discord', user: '123456789012345678' },
			guardian: {
				healthStatus: health.status,
				unauthenticatedStatus: unauthorized.status,
				authenticatedInitializeStatus: authorized.status,
				toolsListStatus: listed.status,
				toolCount: tools.length
			},
			screenshots: [
				welcomeScreenshot,
				narrowWelcomeScreenshot,
				recentScreenshot,
				initialScreenshot,
				assistantScreenshot,
				recoveryScreenshot,
				reflowScreenshot,
				nativeRemoteScreenshot,
				recallScreenshot,
				overviewScreenshot,
				connectionsScreenshot,
				backupScreenshot,
				troubleshootingScreenshot,
				...(readyScreenshot ? [readyScreenshot] : []),
				guardianScreenshot
			],
			keptRunning: keepRunning,
			homeRetained: process.env.OPENPALM_ADMIN_E2E_KEEP_HOME === 'true'
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
		const failure = {
			ok: false,
			error: message(error),
			homeDir: process.env.OP_HOME,
			homeRetained: process.env.OPENPALM_ADMIN_E2E_KEEP_HOME === 'true'
		};
		if (outputDir) {
			mkdirSync(outputDir, { recursive: true });
			writeFileSync(join(outputDir, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
		}
		process.stderr.write(`Admin E2E failed: ${failure.error}\n`);
		app.exit(1);
	}
}

void main();
