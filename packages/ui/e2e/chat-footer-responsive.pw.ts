import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({
	hasTouch: true,
	isMobile: true,
	viewport: { width: 420, height: 700 }
});

const ASSISTANT_ID = 'responsive-assistant';
const SESSION_ID = 'responsive-session';
const CHAT_PATH = `/chat?session=${SESSION_ID}&assistant=${ASSISTANT_ID}`;
const ENCODED_RETURN_TO = '%2Fchat%3Fsession%3Dresponsive-session%26assistant%3Dresponsive-assistant';

type Rect = { left: number; right: number; top: number; bottom: number };

async function rect(locator: Locator): Promise<Rect> {
	const box = await locator.boundingBox();
	expect(box).not.toBeNull();
	return {
		left: box?.x ?? 0,
		right: (box?.x ?? 0) + (box?.width ?? 0),
		top: box?.y ?? 0,
		bottom: (box?.y ?? 0) + (box?.height ?? 0)
	};
}

function intersects(a: Rect, b: Rect): boolean {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function expectHitTarget(locator: Locator, description: string): Promise<void> {
	const blockedPoints = await locator.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		const points = [
			[bounds.left + bounds.width / 2, bounds.top + bounds.height / 2],
			[bounds.left + bounds.width / 3, bounds.top + bounds.height / 2],
			[bounds.right - bounds.width / 3, bounds.top + bounds.height / 2]
		];

		return points.flatMap(([x, y]) => {
			const hit = document.elementFromPoint(x, y);
			if (hit === element || (hit !== null && element.contains(hit))) return [];
			return [{ x, y, hit: hit instanceof HTMLElement ? hit.outerHTML.slice(0, 160) : null }];
		});
	});
	expect(blockedPoints, description).toEqual([]);
}

async function expectChatInert(page: Page, expected: boolean): Promise<void> {
	for (const selector of [
		'.s-scroll',
		'.s-base',
		'.s-tool-rail',
		'.s-dictate-btn'
	]) {
		const locator = page.locator(selector);
		if ((await locator.count()) === 0) continue;
		expect(await locator.evaluate((element) => (element as HTMLElement).inert), selector).toBe(
			expected
		);
	}
	await expect(page.locator('.navbar')).toBeVisible();
}

async function expectOneDrawer(page: Page, name: string): Promise<Locator> {
	const dialog = page.getByRole('dialog', { name, exact: true });
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveAttribute('id', 'chat-navbar-drawer');
	await expect(page.getByRole('dialog')).toHaveCount(1);
	await expectChatInert(page, true);
	return dialog;
}

async function closeDrawerWithOutro(
	page: Page,
	dialog: Locator,
	trigger: Locator
): Promise<void> {
	await dialog.getByRole('button', { name: /^Close/ }).click();
	await expect(dialog).toBeAttached();
	const animationCount = await dialog.evaluate((element) => element.getAnimations().length);
	expect(animationCount, 'drawer remains mounted for its close outro').toBeGreaterThan(0);
	await dialog.waitFor({ state: 'detached' });
	await expect(trigger).toBeFocused();
	await expectChatInert(page, false);
}

async function login(page: Page): Promise<void> {
	const response = await page.request.post('/api/auth/login', {
		data: { password: process.env.OP_UI_LOGIN_PASSWORD ?? 'e2e-mocked-password' }
	});
	expect(response.ok()).toBe(true);
}

async function mockChat(page: Page): Promise<() => void> {
	let releaseMessage: (() => void) | undefined;

	await page.addInitScript(() => {
		class FakeSpeechRecognition {
			continuous = false;
			interimResults = false;
			lang = '';
			maxAlternatives = 1;
			onend: (() => void) | null = null;
			start(): void {}
			stop(): void {
				this.onend?.();
			}
			abort(): void {}
		}
		Object.defineProperty(window, 'SpeechRecognition', {
			configurable: true,
			value: FakeSpeechRecognition
		});
		window.localStorage.setItem(
			'openpalm.voice.settings',
			JSON.stringify({
				version: 1,
				stt: { provider: 'browser' },
				tts: { provider: 'browser' }
			})
		);
	});

	await page.route('**/runtime-config.json', async (route) => {
		await route.fulfill({
			json: {
				connections: [
					{
						id: ASSISTANT_ID,
						label: 'Responsive assistant',
						baseUrl: 'http://127.0.0.1:3800',
						auth: { mode: 'none' },
						isDefault: true,
						locked: true
					}
				]
			}
		});
	});

	await page.route('**/session**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const headers = { 'access-control-allow-origin': '*' };
		if (request.method() === 'GET' && path === '/session') {
			await route.fulfill({
				json: [
					{
						id: SESSION_ID,
						title: 'Responsive frame work',
						time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 }
					}
				],
				headers
			});
			return;
		}
		if (request.method() === 'GET' && path.endsWith('/message')) {
			await route.fulfill({
				json: [
					{
						info: { id: 'user-1', role: 'user', time: { created: 1_700_000_000_000 } },
						parts: [{ type: 'text', text: 'Inspect the workspace' }]
					},
					{
						info: {
							id: 'assistant-1',
							role: 'assistant',
							time: { created: 1_700_000_000_001 }
						},
						parts: [
							{
								type: 'tool',
								tool: 'read',
								callID: 'read-1',
								state: { status: 'completed', output: 'done' }
							},
							{ type: 'text', text: 'The workspace is ready.' }
						]
					}
				],
				headers
			});
			return;
		}
		if (request.method() === 'POST' && path === '/session') {
			await route.fulfill({ json: { id: SESSION_ID }, headers });
			return;
		}
		if (request.method() === 'POST' && path.endsWith('/message')) {
			await new Promise<void>((resolve) => {
				releaseMessage = resolve;
			});
			await route.fulfill({ json: { parts: [] }, headers });
			return;
		}
		await route.fulfill({ body: '', headers });
	});

	return () => releaseMessage?.();
}

test('shared chat navbar and footer remain responsive from 320px through desktop', async ({
	page
}) => {
	const releaseMessage = await mockChat(page);
	await login(page);
	await page.goto(`/chat?assistant=${ASSISTANT_ID}`);
	await expect(page).toHaveURL(new RegExp(`${CHAT_PATH.replaceAll('?', '\\?')}$`));

	const navbar = page.locator('.navbar');
	const assistant = navbar.getByRole('button', { name: 'Assistant', exact: true });
	const conversation = navbar.getByRole('button', { name: 'Conversation', exact: true });
	const activity = navbar.getByRole('button', { name: 'Activity', exact: true });
	const settings = navbar.getByRole('button', { name: 'Settings', exact: true });
	const mode = navbar.getByRole('button', { name: 'Open in OpenCode', exact: true });
	const brand = navbar.getByRole('link', { name: 'OpenPalm - go to chat', exact: true });
	const headerTargets = [brand, assistant, conversation, activity, mode, settings];
	const dictate = page.getByRole('button', { name: 'Dictate', exact: true });
	const composer = page.locator('.s-composer');
	const input = page.getByRole('textbox', { name: 'Message input' });

	await expect(navbar).toBeVisible();
	await expect(navbar).toHaveCSS('height', '52px');
	await expect(activity).toBeVisible();
	await expect(dictate).toBeVisible();
	await input.fill('responsive target check');

	for (const width of [320, 360, 375, 390, 420]) {
		await page.setViewportSize({ width, height: 700 });
		const send = page.getByRole('button', { name: 'Send message' });
		const [navbarRect, scrollRect, composerRect, dictateRect, sendRect] = await Promise.all([
			rect(navbar),
			rect(page.locator('.s-scroll')),
			rect(composer),
			rect(dictate),
			rect(send)
		]);

		expect(navbarRect.bottom, `${width}px compact header`).toBe(52);
		expect(scrollRect.top, `${width}px chat starts below header`).toBe(52);
		expect(scrollRect.bottom, `${width}px chat fills remaining viewport`).toBe(700);
		expect(intersects(navbarRect, composerRect), `${width}px header overlaps composer`).toBe(false);
		expect(intersects(dictateRect, composerRect), `${width}px bottom mic overlaps composer`).toBe(false);
		expect(intersects(dictateRect, sendRect), `${width}px bottom mic overlaps Send`).toBe(false);
		expect(width - dictateRect.right, `${width}px mic right-corner offset`).toBeLessThanOrEqual(16);
		expect(700 - dictateRect.bottom, `${width}px mic bottom-corner offset`).toBeLessThanOrEqual(16);

		for (const control of [...headerTargets, dictate, send]) {
			const controlRect = await rect(control);
			expect(controlRect.right - controlRect.left, `${width}px target width`).toBeGreaterThanOrEqual(44);
			expect(controlRect.bottom - controlRect.top, `${width}px target height`).toBeGreaterThanOrEqual(44);
			expect(controlRect.left, `${width}px target left edge`).toBeGreaterThanOrEqual(0);
			expect(controlRect.right, `${width}px target right edge`).toBeLessThanOrEqual(width);
			await expectHitTarget(control, `${width}px target is unobstructed`);
		}
	}

	await dictate.click();
	await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeVisible();
	await page.getByRole('button', { name: 'Stop dictation' }).click();
	await expect(dictate).toBeVisible();

	for (const trigger of [assistant, conversation, activity, settings]) {
		await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
		await expect(trigger).toHaveAttribute('aria-controls', 'chat-navbar-drawer');
	}

	await assistant.click();
	const assistantDialog = await expectOneDrawer(page, 'Assistant');
	await expect(assistantDialog.getByRole('group', { name: 'Assistant endpoints' })).toBeVisible();
	await expect(assistantDialog.getByRole('link')).toHaveCount(0);
	await expect(assistantDialog.getByText(/Manage/)).toHaveCount(0);
	await closeDrawerWithOutro(page, assistantDialog, assistant);

	await conversation.click();
	const conversationDialog = await expectOneDrawer(page, 'Conversation');
	await expect(conversationDialog.getByRole('group', { name: 'Conversations' })).toBeVisible();
	await expect(conversationDialog.getByRole('button', { name: 'New conversation' })).toBeVisible();
	await expect(conversationDialog.getByRole('link')).toHaveCount(0);
	await closeDrawerWithOutro(page, conversationDialog, conversation);

	await activity.click();
	const activityDialog = await expectOneDrawer(page, 'Activity');
	await expect(activityDialog.locator('.tool-log')).toBeVisible();
	await closeDrawerWithOutro(page, activityDialog, activity);

	await settings.click();
	const settingsDialog = await expectOneDrawer(page, 'Settings');
	for (const scope of ['Device', 'Host', 'Appearance']) {
		await expect(settingsDialog.getByRole('heading', { name: scope, exact: true })).toBeVisible();
	}
	await expect(settingsDialog.getByRole('link', { name: 'Assistant connections' })).toHaveAttribute(
		'href',
		`/connections?returnTo=${ENCODED_RETURN_TO}`
	);
	await expect(settingsDialog.getByRole('link', { name: 'Voice on this device' })).toHaveAttribute(
		'href',
		`/settings/voice?returnTo=${ENCODED_RETURN_TO}`
	);
	await expect(settingsDialog.getByRole('link', { name: 'Host dashboard' })).toHaveAttribute(
		'href',
		`/host?returnTo=${ENCODED_RETURN_TO}`
	);
	await expect(settingsDialog.getByRole('link', { name: 'Voice service on this host' })).toHaveAttribute(
		'href',
		`/host?tab=addons&addon=voice&returnTo=${ENCODED_RETURN_TO}`
	);
	await closeDrawerWithOutro(page, settingsDialog, settings);

	await page.getByRole('button', { name: 'Send message' }).click();
	const stop = page.getByRole('button', { name: 'Stop generating' });
	await expect(stop).toBeVisible();
	await page.setViewportSize({ width: 320, height: 700 });
	await expectHitTarget(stop, '320px Stop remains unobstructed');
	await expectHitTarget(dictate, '320px bottom mic remains unobstructed while sending');
	releaseMessage();

	await page.setViewportSize({ width: 1100, height: 800 });
	await expect(page.locator('.s-tool-rail')).toBeHidden();
	await page.setViewportSize({ width: 1101, height: 800 });
	await expect(page.locator('.s-tool-rail')).toBeVisible();
	const clipped = await page
		.locator(
			'.s-tool-rail, .s-tool-rail .tool-log, .s-tool-rail .tool-log-list, .s-tool-rail .tool-log-item, .s-tool-rail .tool-log-summary'
		)
		.evaluateAll((elements) =>
			elements.flatMap((element) => {
				const style = getComputedStyle(element);
				return element.scrollWidth > element.clientWidth + 1 ||
					style.boxSizing !== 'border-box' ||
					Number.parseFloat(style.minWidth) !== 0
					? [
							{
								className: element.className,
								scrollWidth: element.scrollWidth,
								clientWidth: element.clientWidth,
								boxSizing: style.boxSizing,
								minWidth: style.minWidth
							}
						]
					: [];
			})
		);
	expect(clipped, '1101px contextual activity rail clipping').toEqual([]);
});
