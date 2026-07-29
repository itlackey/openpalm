import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

const mocks = vi.hoisted(() => {
	const voiceState = {
		status: 'idle',
		sttSupported: true,
		ttsSupported: false,
		sttEngine: 'browser',
		ttsEngine: 'browser',
		ttsAutoEnabled: false,
		autoplayBlocked: false,
		interimTranscript: '',
		errorMessage: '',
		conversationActive: false
	};
	return {
		voiceState,
		initVoice: vi.fn(async () => {}),
		startListening: vi.fn(),
		stopListening: vi.fn(),
		startConversation: vi.fn(),
		stopConversation: vi.fn(),
		stopSpeaking: vi.fn(),
		destroyVoice: vi.fn(),
		chatSend: vi.fn(async () => {}),
		chatSendUtterance: vi.fn(async () => {}),
		setTtsAutoEnabled: vi.fn(),
		page: { url: new URL('http://localhost/connections') }
	};
});

vi.mock('$app/state', () => ({ page: mocks.page }));

vi.mock('$lib/voice/voice-state.svelte.js', () => ({
	voiceState: mocks.voiceState,
	initVoice: mocks.initVoice,
	destroyVoice: mocks.destroyVoice,
	startListening: mocks.startListening,
	stopListening: mocks.stopListening,
	startConversation: mocks.startConversation,
	stopConversation: mocks.stopConversation,
	stopSpeaking: mocks.stopSpeaking,
	setTtsAutoEnabled: mocks.setTtsAutoEnabled,
	resumeAutoplay: vi.fn()
}));

vi.mock('$lib/chat/chat-state.svelte.js', () => ({
	chat: { sending: false, send: mocks.chatSend, sendUtterance: mocks.chatSendUtterance }
}));

import VoiceControl from './VoiceControl.svelte';

type TestBridge = {
	onGlobalMicToggle?: (callback: () => void) => () => void;
	requestMicPermission?: () => Promise<string>;
};

beforeEach(() => {
	mocks.initVoice.mockClear();
	mocks.startListening.mockClear();
	mocks.stopListening.mockClear();
	mocks.startConversation.mockClear();
	mocks.stopConversation.mockClear();
	mocks.stopSpeaking.mockClear();
	mocks.destroyVoice.mockClear();
	mocks.chatSend.mockClear();
	mocks.chatSendUtterance.mockClear();
	mocks.setTtsAutoEnabled.mockClear();
	mocks.voiceState.status = 'idle';
	mocks.voiceState.ttsSupported = false;
	mocks.voiceState.autoplayBlocked = false;
	mocks.voiceState.conversationActive = false;
	mocks.page.url = new URL('http://localhost/connections');
});

afterEach(() => {
	delete (window as Window & { openpalm?: TestBridge }).openpalm;
});

describe('VoiceControl route safety', () => {
	test('disables dictation on settings pages', async () => {
		await render(VoiceControl);

		await expect
			.element(page.getByRole('button', { name: 'Voice input unavailable outside chat' }))
			.toBeDisabled();
	});

	test('a global microphone toggle on settings pages never starts capture or sends', async () => {
		let globalToggle: (() => void) | undefined;
		(window as Window & { openpalm?: TestBridge }).openpalm = {
			onGlobalMicToggle(callback) {
				globalToggle = callback;
				return () => {};
			}
		};
		await render(VoiceControl);
		await vi.waitFor(() => expect(globalToggle).toBeTypeOf('function'));

		globalToggle?.();

		expect(mocks.startListening).not.toHaveBeenCalled();
		expect(mocks.chatSend).not.toHaveBeenCalled();
	});

	test('keeps dictation available on the advanced chat surface', async () => {
		mocks.page.url = new URL('http://localhost/advanced');
		mocks.startListening.mockImplementation((onResult: (text: string) => void) => {
			onResult(' dictated message ');
		});
		await render(VoiceControl);

		await page.getByRole('button', { name: 'Dictate message' }).click();

		expect(mocks.startListening).toHaveBeenCalledOnce();
		expect(mocks.chatSend).toHaveBeenCalledWith('dictated message');
	});

	test('ignores a transcript delivered after the control unmounts', async () => {
		mocks.page.url = new URL('http://localhost/advanced');
		let deliverTranscript: ((text: string) => void) | undefined;
		mocks.startListening.mockImplementation((onResult: (text: string) => void) => {
			deliverTranscript = onResult;
		});
		const { unmount } = await render(VoiceControl);

		await page.getByRole('button', { name: 'Dictate message' }).click();
		await unmount();
		deliverTranscript?.('late transcript');

		expect(mocks.chatSend).not.toHaveBeenCalled();
	});

	test('does not start capture when microphone permission resolves after unmount', async () => {
		mocks.page.url = new URL('http://localhost/advanced');
		let resolvePermission: ((status: string) => void) | undefined;
		const requestMicPermission = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolvePermission = resolve;
				})
		);
		(window as Window & { openpalm?: TestBridge }).openpalm = { requestMicPermission };
		const { unmount } = await render(VoiceControl);

		await page.getByRole('button', { name: 'Dictate message' }).click();
		await vi.waitFor(() => expect(requestMicPermission).toHaveBeenCalledOnce());
		await unmount();
		resolvePermission?.('granted');
		await vi.waitFor(() => expect(mocks.startListening).not.toHaveBeenCalled());
	});

	test('coalesces repeated microphone toggles while permission is pending', async () => {
		mocks.page.url = new URL('http://localhost/advanced');
		let globalToggle: (() => void) | undefined;
		let resolvePermission: ((status: string) => void) | undefined;
		const requestMicPermission = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolvePermission = resolve;
				})
		);
		(window as Window & { openpalm?: TestBridge }).openpalm = {
			requestMicPermission,
			onGlobalMicToggle(callback) {
				globalToggle = callback;
				return () => {};
			}
		};
		await render(VoiceControl);
		await expect.element(page.getByRole('button', { name: 'Dictate message' })).toBeEnabled();
		await vi.waitFor(() => expect(globalToggle).toBeTypeOf('function'));

		globalToggle?.();
		globalToggle?.();
		expect(requestMicPermission).toHaveBeenCalledOnce();
		resolvePermission?.('granted');

		await vi.waitFor(() => expect(mocks.startListening).toHaveBeenCalledOnce());
	});

	test('disables dictation while remote audio is being transcribed', async () => {
		mocks.page.url = new URL('http://localhost/advanced');
		mocks.voiceState.status = 'transcribing';
		await render(VoiceControl);

		await expect.element(page.getByRole('button', { name: 'Transcribing message' })).toBeDisabled();
	});
});

describe('VoiceControl accessibility', () => {
	test('gives every voice target a 44px target and a two-pixel focus indicator', async () => {
		mocks.voiceState.ttsSupported = true;
		const { container } = await render(VoiceControl);
		container.style.setProperty('--s-seal', '#b53a2d');
		await expect
			.element(page.getByRole('button', { name: 'Turn on spoken responses' }))
			.toBeVisible();

		const buttons = container.querySelectorAll<HTMLButtonElement>('button');
		expect(buttons.length).toBe(3);
		for (const button of buttons) {
			const bounds = button.getBoundingClientRect();
			expect(bounds.width).toBeGreaterThanOrEqual(44);
			expect(bounds.height).toBeGreaterThanOrEqual(44);
		}

		const enabledButtons = container.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
		for (const button of enabledButtons) {
			button.focus({ focusVisible: true });
			expect(document.activeElement).toBe(button);
			const style = getComputedStyle(button);
			expect(style.outlineStyle).not.toBe('none');
			expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
		}
	});

	test('exposes the same three controls on the advanced chat surface', async () => {
		mocks.page.url = new URL('http://localhost/advanced');
		mocks.voiceState.ttsSupported = true;
		const { container } = await render(VoiceControl);

		await expect.element(page.getByRole('button', { name: 'Dictate message' })).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Start conversation mode' }))
			.toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Turn on spoken responses' }))
			.toBeVisible();
		const buttons = container.querySelectorAll<HTMLButtonElement>('button');
		expect(buttons).toHaveLength(3);
	});
});
