import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

test.use({
	hasTouch: true,
	isMobile: true,
	viewport: { width: 420, height: 700 }
});

const ASSISTANT_ID = 'responsive-assistant';
const SESSION_ID = 'responsive-session';
const CHAT_PATH = `/chat?session=${SESSION_ID}&assistant=${ASSISTANT_ID}`;
const ENCODED_RETURN_TO =
	'%2Fchat%3Fsession%3Dresponsive-session%26assistant%3Dresponsive-assistant';

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
		'.s-tool-rail',
		'.chat-footer-composer',
		'.chat-footer-voice'
	]) {
		const locator = page.locator(selector);
		if ((await locator.count()) === 0) continue;
		expect(await locator.evaluate((element) => (element as HTMLElement).inert), selector).toBe(
			expected
		);
	}
	await expect(page.locator('.navbar')).toBeVisible();
}

async function expectOneDrawer(
	page: Page,
	name: string,
	id = 'chat-navbar-drawer'
): Promise<Locator> {
	const dialog = page.getByRole('dialog', { name, exact: true });
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveAttribute('id', id);
	await expect(page.getByRole('dialog')).toHaveCount(1);
	await expectChatInert(page, true);
	return dialog;
}

async function closeDrawerWithOutro(page: Page, dialog: Locator, trigger: Locator): Promise<void> {
	await dialog.getByRole('button', { name: /^Close/ }).click();
	await expect(dialog).toBeAttached();
	const animationCount = await dialog.evaluate((element) => element.getAnimations().length);
	expect(animationCount, 'drawer remains mounted for its close outro').toBeGreaterThan(0);
	await dialog.waitFor({ state: 'detached' });
	await expect(trigger).toBeFocused();
	await expectChatInert(page, false);
}

async function login(page: Page): Promise<void> {
	const password =
		process.env.RUN_DOCKER_STACK_TESTS === '1'
			? process.env.OP_UI_LOGIN_PASSWORD
			: 'e2e-mocked-password';
	const response = await page.request.post('/api/auth/login', {
		data: { password: password ?? '' }
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
	const assistant = navbar.getByRole('button', {
		name: 'Assistant: Responsive assistant',
		exact: true
	});
	const conversation = navbar.getByRole('button', {
		name: 'Conversation: Responsive frame work',
		exact: true
	});
	const newConversation = page.getByRole('button', {
		name: 'Start a new conversation',
		exact: true
	});
	const activity = page.getByRole('button', {
		name: 'Activity for Responsive frame work',
		exact: true
	});
	const settings = navbar.getByRole('link', { name: 'Open settings', exact: true });
	const simpleMode = navbar.getByRole('link', { name: 'Chat', exact: true });
	const openCodeMode = navbar.getByRole('link', { name: 'Advanced', exact: true });
	const surfaceToolbar = navbar.locator('.surface-toolbar');
	const brand = navbar.getByRole('link', { name: 'OpenPalm - go to chat', exact: true });
	const headerTargets = [brand, assistant, conversation, simpleMode, openCodeMode, settings];
	const speaker = page.getByRole('button', { name: 'Turn on spoken responses', exact: true });
	const conversationMode = page.getByRole('button', {
		name: 'Start conversation mode',
		exact: true
	});
	const dictate = page.getByRole('button', { name: 'Dictate message', exact: true });
	const footer = page.locator('.chat-footer');
	const composer = page.locator('.s-composer');
	const input = page.getByRole('textbox', { name: 'Message input' });

	await expect(navbar).toBeVisible();
	await expect(navbar).toHaveCSS('height', '144px');
	await expect(activity).toBeVisible();
	await expect(activity).toHaveText('');
	await expect(settings).toHaveText('');
	await expect(simpleMode).toHaveText('');
	await expect(openCodeMode).toHaveText('');
	await expect(dictate).toBeVisible();
	for (const control of [speaker, conversationMode, dictate]) {
		await expect(control).toHaveCSS('border-top-width', '0px');
	}
	await input.fill('responsive target check');

	for (const width of [320, 360, 375, 390, 420]) {
		await page.setViewportSize({ width, height: 700 });
		await expect(surfaceToolbar).toHaveCSS('height', '52px');
		const toolbarLastAction = surfaceToolbar.locator('a, button').last();
		const send = page.getByRole('button', { name: 'Send message' });
		const [
			navbarRect,
			scrollRect,
			composerRect,
			inputRect,
			sendRect,
			newConversationRect,
			activityRect,
			speakerRect,
			conversationModeRect,
			dictateRect,
			footerRect
		] = await Promise.all([
			rect(navbar),
			rect(page.locator('.s-scroll')),
			rect(composer),
			rect(input),
			rect(send),
			rect(newConversation),
			rect(activity),
			rect(speaker),
			rect(conversationMode),
			rect(dictate),
			rect(footer)
		]);

		expect(navbarRect.bottom, `${width}px contextual header`).toBe(144);
		expect((await rect(toolbarLastAction)).right, `${width}px toolbar right inset`).toBe(width - 4);
		expect(scrollRect.top, `${width}px chat starts below header`).toBe(144);
		expect(scrollRect.bottom, `${width}px chat ends above footer`).toBe(footerRect.top);
		expect(footerRect.bottom, `${width}px footer reaches viewport bottom`).toBe(700);
		expect(intersects(navbarRect, composerRect), `${width}px header overlaps composer`).toBe(false);
		expect(composerRect.top, `${width}px composer starts inside footer`).toBeGreaterThanOrEqual(
			footerRect.top
		);
		expect(composerRect.bottom, `${width}px composer ends inside footer`).toBeLessThanOrEqual(
			footerRect.bottom
		);
		expect(inputRect.right, `${width}px message field precedes Send`).toBeLessThanOrEqual(
			sendRect.left
		);
		expect(
			Math.min(inputRect.bottom, sendRect.bottom) - Math.max(inputRect.top, sendRect.top),
			`${width}px message field and Send share the upper row`
		).toBeGreaterThan(0);
		expect(intersects(dictateRect, composerRect), `${width}px bottom mic overlaps composer`).toBe(
			false
		);
		expect(intersects(dictateRect, sendRect), `${width}px bottom mic overlaps Send`).toBe(false);
		expect(width - dictateRect.right, `${width}px mic right-corner offset`).toBeLessThanOrEqual(16);
		expect(700 - dictateRect.bottom, `${width}px mic bottom-corner offset`).toBeLessThanOrEqual(16);
		const bottomRow = [
			newConversationRect,
			activityRect,
			speakerRect,
			conversationModeRect,
			dictateRect
		];
		expect(
			Math.max(...bottomRow.map((control) => control.top)) -
				Math.min(...bottomRow.map((control) => control.top)),
			`${width}px bottom controls share one row`
		).toBeLessThanOrEqual(1);
		for (let index = 1; index < bottomRow.length; index++) {
			expect(
				bottomRow[index - 1].right,
				`${width}px bottom control ${index} precedes control ${index + 1}`
			).toBeLessThanOrEqual(bottomRow[index].left);
		}

		const modeOverflow = await navbar.locator('.conversation-nav').evaluate((switcher) => {
			const bounds = switcher.getBoundingClientRect();
			return Array.from(switcher.querySelectorAll('button')).some((button) => {
				const buttonBounds = button.getBoundingClientRect();
				return (
					buttonBounds.left < bounds.left ||
					buttonBounds.right > bounds.right ||
					buttonBounds.top < bounds.top ||
					buttonBounds.bottom > bounds.bottom
				);
			});
		});
		expect(modeOverflow, `${width}px mode switch overflow`).toBe(false);

		expect(
			newConversationRect.right,
			`${width}px new conversation precedes Activity`
		).toBeLessThanOrEqual(activityRect.left);
		expect(
			700 - newConversationRect.bottom,
			`${width}px new conversation bottom offset`
		).toBeLessThanOrEqual(16);

		for (const control of [
			...headerTargets,
			newConversation,
			activity,
			speaker,
			conversationMode,
			dictate,
			send
		]) {
			const controlRect = await rect(control);
			expect(
				controlRect.right - controlRect.left,
				`${width}px target width`
			).toBeGreaterThanOrEqual(44);
			expect(
				controlRect.bottom - controlRect.top,
				`${width}px target height`
			).toBeGreaterThanOrEqual(44);
			expect(controlRect.left, `${width}px target left edge`).toBeGreaterThanOrEqual(0);
			expect(controlRect.right, `${width}px target right edge`).toBeLessThanOrEqual(width);
			await expectHitTarget(control, `${width}px target is unobstructed`);
		}
	}

	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(surfaceToolbar).toHaveCSS('height', '52px');
	await expect(navbar).toHaveCSS('height', '52px');
	const [wideToolbar, wideNavbar] = await Promise.all([rect(surfaceToolbar), rect(navbar)]);
	expect(wideToolbar.top, 'wide toolbar stays at the shared header origin').toBe(wideNavbar.top);
	expect(wideToolbar.right, 'wide toolbar keeps the shared header inset').toBe(wideNavbar.right - 20);
	const [wideFooter, wideComposer, wideInput, wideSend, wideNewConversation, wideActivity, wideSpeaker, wideConversation, wideDictate] =
		await Promise.all([
			rect(footer),
			rect(composer),
			rect(input),
			rect(page.getByRole('button', { name: 'Send message' })),
			rect(newConversation),
			rect(activity),
			rect(speaker),
			rect(conversationMode),
			rect(dictate)
		]);
	expect(wideFooter.bottom - wideFooter.top, 'wide footer stays compact').toBeLessThanOrEqual(68);
	expect(
		Math.min(wideInput.bottom, wideSend.bottom) - Math.max(wideInput.top, wideSend.top),
		'wide message input and Send share one row'
	).toBeGreaterThan(0);
	expect(wideNewConversation.right, 'wide conversation actions precede composer').toBeLessThanOrEqual(
		wideComposer.left
	);
	expect(wideActivity.right, 'wide Activity precedes composer').toBeLessThanOrEqual(
		wideComposer.left
	);
	expect(wideComposer.right, 'wide composer precedes voice controls').toBeLessThanOrEqual(
		wideSpeaker.left
	);
	for (const [name, controlRect] of [
		['new conversation', wideNewConversation],
		['activity', wideActivity],
		['speaker', wideSpeaker],
		['conversation mode', wideConversation],
		['dictation', wideDictate]
	] as const) {
		expect(
			Math.min(wideComposer.bottom, controlRect.bottom) - Math.max(wideComposer.top, controlRect.top),
			`wide ${name} control shares the composer row`
		).toBeGreaterThan(0);
	}
	await page.setViewportSize({ width: 420, height: 700 });

	await dictate.click();
	await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeVisible();
	await page.getByRole('button', { name: 'Stop dictation' }).click();
	await expect(dictate).toBeVisible();

	await conversationMode.click();
	const stopConversationMode = page.getByRole('button', { name: 'Stop conversation mode' });
	await expect(stopConversationMode).toBeVisible();
	await stopConversationMode.click();
	await expect(conversationMode).toBeVisible();

	await speaker.click();
	const stopSpeaker = page.getByRole('button', { name: 'Turn off spoken responses' });
	await expect(stopSpeaker).toBeVisible();
	await stopSpeaker.click();
	await expect(speaker).toBeVisible();

	for (const trigger of [assistant, conversation]) {
		await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
		await expect(trigger).toHaveAttribute('aria-controls', 'chat-navbar-drawer');
	}
	await expect(activity).toHaveAttribute('aria-haspopup', 'dialog');
	await expect(activity).not.toHaveAttribute('aria-controls', /.+/);
	await expect(settings).toHaveAttribute('href', `/connections?returnTo=${ENCODED_RETURN_TO}`);

	await assistant.click();
	const assistantDialog = await expectOneDrawer(page, 'Switch assistant');
	await expect(assistantDialog.getByRole('group', { name: 'Assistants' })).toBeVisible();
	await expect(
		assistantDialog.getByRole('link', { name: /Manage assistant connections/ })
	).toBeVisible();
	await closeDrawerWithOutro(page, assistantDialog, assistant);

	await conversation.click();
	const conversationDialog = await expectOneDrawer(page, 'Conversations');
	await expect(conversationDialog.getByRole('group', { name: 'Conversations' })).toBeVisible();
	await expect(conversationDialog.getByRole('button', { name: 'New conversation' })).toBeVisible();
	await expect(conversationDialog.getByRole('link')).toHaveCount(0);
	await closeDrawerWithOutro(page, conversationDialog, conversation);

	await activity.click();
	const activityDialog = await expectOneDrawer(page, 'Activity', 'conversation-activity-drawer');
	await expect(activity).toHaveAttribute('aria-controls', 'conversation-activity-drawer');
	await expect(activityDialog.locator('.tool-log')).toBeVisible();
	await closeDrawerWithOutro(page, activityDialog, activity);
	await expect(activity).not.toHaveAttribute('aria-controls', /.+/);

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

	await page.setViewportSize({ width: 320, height: 700 });
	await expect(navbar).toHaveCSS('height', '144px');
	await openCodeMode.click();
	await expect(page).toHaveURL(/\/advanced(?:\?|$)/);
	await expect(surfaceToolbar).toHaveCSS('height', '52px');
	await expect(navbar).toHaveCSS('height', '52px');
	await expect(assistant).toHaveCount(0);
	await expect(conversation).toHaveCount(0);
	await expect(newConversation).toHaveCount(0);
	const advancedFooter = page.locator('.chat-footer');
	const advancedContent = page.locator(
		'.opencode-shell:visible, .native-shell:visible, .advanced-status:visible'
	);
	const advancedSpeaker = page.getByRole('button', { name: 'Turn on spoken responses' });
	const advancedConversation = page.getByRole('button', { name: 'Start conversation mode' });
	const advancedDictate = page.getByRole('button', { name: 'Dictate message' });
	await expect(advancedFooter).toBeVisible();
	const [footerRect, contentRect] = await Promise.all([rect(advancedFooter), rect(advancedContent)]);
	expect(contentRect.bottom, 'OpenCode content ends above its voice footer').toBeLessThanOrEqual(
		footerRect.top
	);
	for (const control of [advancedSpeaker, advancedConversation, advancedDictate]) {
		await expect(control).toBeVisible();
		const controlRect = await rect(control);
		expect(controlRect.top, 'advanced voice control stays inside footer').toBeGreaterThanOrEqual(
			footerRect.top
		);
		expect(controlRect.bottom, 'advanced voice control stays inside footer').toBeLessThanOrEqual(
			footerRect.bottom
		);
	}
});
