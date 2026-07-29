import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

const mocks = vi.hoisted(() => {
	const voiceState = {
		status: 'idle',
		sttEngine: 'browser',
		ttsEngine: 'openpalm-voice',
		sttSupported: true,
		ttsSupported: true,
		ttsAutoEnabled: false,
		errorMessage: '',
	};
	return {
		voiceState,
		probeVoiceEndpoint: vi.fn(async () => false),
		refreshAdvertisedVoiceUrl: vi.fn(async () => '/voice'),
		startListening: vi.fn(),
		stopListening: vi.fn(),
		speakText: vi.fn(async () => {}),
		saveVoiceSettings: vi.fn(),
		loadVoiceSettings: vi.fn(),
	};
});

vi.mock('$lib/voice/settings-store.js', () => ({
	loadVoiceSettings: mocks.loadVoiceSettings,
	saveVoiceSettings: mocks.saveVoiceSettings,
	voiceSecretsEncryptedAtRest: () => true,
}));

vi.mock('$lib/voice/providers.js', () => ({
	probeVoiceEndpoint: mocks.probeVoiceEndpoint,
	refreshAdvertisedVoiceUrl: mocks.refreshAdvertisedVoiceUrl,
}));

vi.mock('$lib/voice/voice-state.svelte.js', () => ({
	voiceState: mocks.voiceState,
	initVoice: vi.fn(async () => {}),
	isIosSafari: vi.fn(() => false),
	setTtsAutoEnabled: vi.fn(),
	speakText: mocks.speakText,
		startListening: mocks.startListening,
		stopListening: mocks.stopListening,
		stopSpeaking: vi.fn(),
}));

vi.mock('$lib/connections/boot.js', () => ({
	getSecretStore: () => ({
		set: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
	}),
}));

vi.mock('$lib/connections/store.js', () => ({ newConnectionId: () => 'voice-key-ref' }));
vi.mock('$lib/notifications.svelte.js', () => ({ notifications: { push: vi.fn() } }));

import VoiceClientSettings from './VoiceClientSettings.svelte';

beforeEach(() => {
	mocks.loadVoiceSettings.mockReturnValue({
		version: 1,
		stt: { provider: 'browser' },
		tts: { provider: 'openpalm-voice' },
	});
	mocks.voiceState.status = 'idle';
	mocks.voiceState.errorMessage = '';
	mocks.probeVoiceEndpoint.mockClear();
	mocks.refreshAdvertisedVoiceUrl.mockClear();
	mocks.startListening.mockReset();
	mocks.stopListening.mockClear();
	mocks.speakText.mockReset();
	mocks.speakText.mockResolvedValue(undefined);
	mocks.saveVoiceSettings.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('VoiceClientSettings provider status', () => {
	test('does not call an advertised but unreachable OpenPalm provider available', async () => {
		await render(VoiceClientSettings);

		await expect.element(page.getByText(/advertised.*not reachable/i).first(), { timeout: 5000 }).toBeVisible();
		await expect.element(page.getByText(/Available on this host/i)).not.toBeInTheDocument();
	});
});

describe('VoiceClientSettings accessibility and mobile layout', () => {
	test('keeps mobile grids and provider selects inside a 320px viewport', async () => {
		const { container } = await render(VoiceClientSettings);
		container.style.width = '296px';
		await expect.element(page.getByRole('combobox').first()).toBeVisible();

		for (const grid of container.querySelectorAll<HTMLElement>('.voice-grid, .test-grid')) {
			expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);
		}
		for (const select of container.querySelectorAll('select')) {
			expect(select.scrollWidth).toBeLessThanOrEqual(select.clientWidth);
		}
	});

	test('provides a 24px checkbox in a 44px labeled target', async () => {
		const { container } = await render(VoiceClientSettings);
		const checkbox = page.getByRole('checkbox', { name: 'Speak replies automatically' });
		await expect.element(checkbox).toBeVisible();

		const checkboxBounds = checkbox.element().getBoundingClientRect();
		const rowBounds = container.querySelector('.field-inline')?.getBoundingClientRect();
		expect(checkboxBounds.width).toBeGreaterThanOrEqual(24);
		expect(checkboxBounds.height).toBeGreaterThanOrEqual(24);
		expect(rowBounds?.height).toBeGreaterThanOrEqual(44);
	});

	test('gives every settings action a 44px target', async () => {
		const { container } = await render(VoiceClientSettings);
		await expect.element(page.getByText(/advertised.*not reachable/i).first(), { timeout: 5000 }).toBeVisible();

		const actions = container.querySelectorAll<HTMLButtonElement>('.voice-settings button');
		expect(actions.length).toBeGreaterThan(0);
		for (const action of actions) {
			const bounds = action.getBoundingClientRect();
			expect(bounds.width).toBeGreaterThanOrEqual(44);
			expect(bounds.height).toBeGreaterThanOrEqual(44);
		}
	});

	test('shows a two-pixel focus indicator on every enabled control', async () => {
		const { container } = await render(VoiceClientSettings);
		container.style.setProperty('--s-ink', '#26292b');
		await expect.element(page.getByText(/advertised.*not reachable/i).first(), { timeout: 5000 }).toBeVisible();
		const controls = container.querySelectorAll<HTMLElement>(
			'select:not(:disabled), input:not(:disabled), button:not(:disabled)',
		);
		for (const control of controls) {
			control.focus();
			expect(document.activeElement).toBe(control);
			const style = getComputedStyle(control);
			expect(style.outlineStyle).not.toBe('none');
			expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
		}
	});
});

describe('VoiceClientSettings tests', () => {
	test('describes API keys as encrypted only when encrypted storage is active', async () => {
		mocks.loadVoiceSettings.mockReturnValue({
			version: 1,
			stt: { provider: 'openai-compatible', baseURL: 'https://speech.example/v1' },
			tts: { provider: 'openai-compatible', baseURL: 'https://speech.example/v1' },
		});
		await render(VoiceClientSettings);

		await expect.element(page.getByText(/Stored encrypted in this browser only/i).first()).toBeVisible();
		await expect.element(page.getByText(/without at-rest encryption/i)).not.toBeInTheDocument();
	});

	test('microphone test displays a local transcript and says it is never sent', async () => {
		let deliver: (() => void) | undefined;
		mocks.startListening.mockImplementation(
			(onResult: (text: string) => void, onSettled: () => void) => {
				deliver = () => {
					onResult('local microphone transcript');
					onSettled();
				};
			},
		);
		await render(VoiceClientSettings);

		await expect.element(page.getByText(/never sent to the assistant/i)).toBeVisible();
		await page.getByRole('button', { name: 'Test microphone' }).click();
		expect(mocks.startListening).toHaveBeenCalledOnce();

		deliver?.();
		await expect.element(page.getByText('local microphone transcript', { exact: true })).toBeVisible();
	});

	test('automatically stops microphone capture after ten seconds', async () => {
		await render(VoiceClientSettings);
		const button = page.getByRole('button', { name: 'Test microphone' });
		await expect.element(button).toBeVisible();
		mocks.stopListening.mockClear();
		vi.useFakeTimers();

		await button.click();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(mocks.startListening).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(mocks.stopListening).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(mocks.stopListening).toHaveBeenCalledOnce();
	});

	test('speaker test reports a selected-provider failure', async () => {
		mocks.speakText.mockImplementation(async () => {
			mocks.voiceState.errorMessage = 'Voice engine is unreachable.';
		});
		await render(VoiceClientSettings);

		await page.getByRole('button', { name: 'Test speaker' }).click();

		await expect.element(page.getByRole('alert')).toHaveTextContent(/unreachable/i);
	});
});
