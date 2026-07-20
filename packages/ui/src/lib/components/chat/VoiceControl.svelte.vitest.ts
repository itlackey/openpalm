import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

const mocks = vi.hoisted(() => {
	const voiceState = {
		status: 'idle',
		sttSupported: true,
		ttsSupported: false,
		sttEngine: 'browser',
		ttsEngine: 'disabled',
		ttsAutoEnabled: false,
		autoplayBlocked: false,
		interimTranscript: '',
		errorMessage: '',
	};
	return {
		voiceState,
		initVoice: vi.fn(async () => {}),
		startListening: vi.fn(),
		stopListening: vi.fn(),
		stopSpeaking: vi.fn(),
		destroyVoice: vi.fn(),
		chatSend: vi.fn(async () => {}),
		page: { url: new URL('http://localhost/connections') },
	};
});

vi.mock('$app/state', () => ({ page: mocks.page }));

vi.mock('$lib/voice/voice-state.svelte.js', () => ({
	voiceState: mocks.voiceState,
	initVoice: mocks.initVoice,
	destroyVoice: mocks.destroyVoice,
	startListening: mocks.startListening,
	stopListening: mocks.stopListening,
	stopSpeaking: mocks.stopSpeaking,
	setTtsAutoEnabled: vi.fn(),
	resumeAutoplay: vi.fn(),
}));

vi.mock('$lib/chat/chat-state.svelte.js', () => ({
	chat: { sending: false, send: mocks.chatSend },
}));

import VoiceControl from './VoiceControl.svelte';

type TestBridge = {
	onGlobalMicToggle?: (callback: () => void) => () => void;
};

beforeEach(() => {
	mocks.initVoice.mockClear();
	mocks.startListening.mockClear();
	mocks.stopListening.mockClear();
	mocks.stopSpeaking.mockClear();
	mocks.destroyVoice.mockClear();
	mocks.chatSend.mockClear();
	mocks.voiceState.status = 'idle';
	mocks.voiceState.ttsSupported = false;
	mocks.voiceState.autoplayBlocked = false;
	mocks.page.url = new URL('http://localhost/connections');
});

afterEach(() => {
	delete (window as Window & { openpalm?: TestBridge }).openpalm;
});

describe('VoiceControl route safety', () => {
	test('disables dictation on settings pages', async () => {
		render(VoiceControl);

		await expect.element(
			page.getByRole('button', { name: 'Voice input unavailable outside chat' }),
		).toBeDisabled();
	});

	test('a global microphone toggle on settings pages never starts capture or sends', async () => {
		let globalToggle: (() => void) | undefined;
		(window as Window & { openpalm?: TestBridge }).openpalm = {
			onGlobalMicToggle(callback) {
				globalToggle = callback;
				return () => {};
			},
		};
		render(VoiceControl);
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
		render(VoiceControl);

		await page.getByRole('button', { name: 'Speak and send' }).click();

		expect(mocks.startListening).toHaveBeenCalledOnce();
		expect(mocks.chatSend).toHaveBeenCalledWith('dictated message');
	});
});

describe('VoiceControl accessibility', () => {
	test('gives every voice target a 44px target and a two-pixel focus indicator', async () => {
		mocks.voiceState.ttsSupported = true;
		mocks.voiceState.autoplayBlocked = true;
		const { container } = render(VoiceControl);
		container.style.setProperty('--s-ink', '#26292b');
		await expect.element(page.getByRole('button', { name: 'Resume paused audio' })).toBeVisible();

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

	test('can expose only one 44px microphone target for a floating chat control', async () => {
		mocks.page.url = new URL('http://localhost/advanced');
		mocks.voiceState.ttsSupported = true;
		const { container } = render(VoiceControl, { props: { showSpeaker: false } });

		await expect.element(page.getByRole('button', { name: 'Speak and send' })).toBeVisible();
		expect(page.getByRole('button', { name: /spoken responses/i }).elements()).toHaveLength(0);
		const buttons = container.querySelectorAll<HTMLButtonElement>('button');
		expect(buttons).toHaveLength(1);
		const bounds = buttons[0].getBoundingClientRect();
		expect(bounds.width).toBeGreaterThanOrEqual(44);
		expect(bounds.height).toBeGreaterThanOrEqual(44);
	});
});
