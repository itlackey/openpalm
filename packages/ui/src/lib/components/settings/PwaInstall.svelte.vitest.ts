import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { pwaInstallService } from '$lib/pwa-install-state.svelte.js';
import PwaInstall from './PwaInstall.svelte';

type InstallChoice = { outcome: 'accepted' | 'dismissed' };
type TestInstallPromptEvent = Event & {
	prompt: ReturnType<typeof vi.fn>;
	userChoice: Promise<InstallChoice>;
};

const originalMatchMedia = window.matchMedia;
const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
let standalone = false;
let displayModeListeners: Array<() => void> = [];
let removeDisplayModeListener: ReturnType<typeof vi.fn>;

function setNavigatorValue(
	key: 'userAgent' | 'platform' | 'maxTouchPoints',
	value: string | number
): void {
	Object.defineProperty(navigator, key, { configurable: true, value });
}

function restoreNavigatorValue(
	key: 'userAgent' | 'platform' | 'maxTouchPoints',
	descriptor: PropertyDescriptor | undefined
): void {
	if (descriptor) Object.defineProperty(navigator, key, descriptor);
	else delete (navigator as unknown as Record<string, unknown>)[key];
}

function installPromptEvent(outcome: InstallChoice['outcome']): TestInstallPromptEvent {
	return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
		prompt: vi.fn().mockResolvedValue(undefined),
		userChoice: Promise.resolve({ outcome })
	});
}

beforeEach(() => {
	standalone = false;
	displayModeListeners = [];
	removeDisplayModeListener = vi.fn();
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: vi.fn().mockImplementation(() => ({
			get matches() {
				return standalone;
			},
			addEventListener: vi.fn((_type: string, listener: () => void) => {
				displayModeListeners.push(listener);
			}),
			removeEventListener: removeDisplayModeListener
		}))
	});
	setNavigatorValue('userAgent', 'Mozilla/5.0 Chrome/126 Safari/537.36');
	setNavigatorValue('platform', 'Linux x86_64');
	setNavigatorValue('maxTouchPoints', 0);
});

afterEach(() => {
	pwaInstallService.dispose();
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: originalMatchMedia
	});
	restoreNavigatorValue('userAgent', originalUserAgent);
	restoreNavigatorValue('platform', originalPlatform);
	restoreNavigatorValue('maxTouchPoints', originalMaxTouchPoints);
	vi.restoreAllMocks();
});

describe('PwaInstall', () => {
	test('shows a native prompt captured before the settings component mounts', async () => {
		pwaInstallService.init();
		const event = installPromptEvent('accepted');
		window.dispatchEvent(event);
		render(PwaInstall);

		await expect.element(page.getByRole('button', { name: 'Install OpenPalm' })).toBeVisible();
		expect(event.defaultPrevented).toBe(true);
		expect(event.prompt).not.toHaveBeenCalled();
	});

	test('reports an accepted native prompt', async () => {
		pwaInstallService.init();
		render(PwaInstall);
		const event = installPromptEvent('accepted');
		window.dispatchEvent(event);

		await page.getByRole('button', { name: 'Install OpenPalm' }).click();

		await expect.element(page.getByText(/Installation accepted/i)).toBeVisible();
		expect(event.prompt).toHaveBeenCalledOnce();
	});

	test('reports a dismissed native prompt without reusing it', async () => {
		pwaInstallService.init();
		render(PwaInstall);
		const event = installPromptEvent('dismissed');
		window.dispatchEvent(event);

		await page.getByRole('button', { name: 'Install OpenPalm' }).click();

		await expect.element(page.getByText(/Install dismissed/i)).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Install OpenPalm' }))
			.not.toBeInTheDocument();
		expect(event.prompt).toHaveBeenCalledOnce();
	});

	test('replaces the action when installation completes', async () => {
		pwaInstallService.init();
		render(PwaInstall);
		window.dispatchEvent(installPromptEvent('accepted'));
		await expect.element(page.getByRole('button', { name: 'Install OpenPalm' })).toBeVisible();

		window.dispatchEvent(new Event('appinstalled'));

		await expect.element(page.getByText('OpenPalm is installed on this device.')).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Install OpenPalm' }))
			.not.toBeInTheDocument();
	});

	test('starts installed and keeps the action hidden in standalone display mode', async () => {
		standalone = true;
		pwaInstallService.init();
		render(PwaInstall);

		await expect.element(page.getByText('OpenPalm is installed on this device.')).toBeVisible();
		window.dispatchEvent(installPromptEvent('accepted'));
		await expect
			.element(page.getByRole('button', { name: 'Install OpenPalm' }))
			.not.toBeInTheDocument();
	});

	test('replaces an available action when display mode changes to standalone', async () => {
		pwaInstallService.init();
		window.dispatchEvent(installPromptEvent('accepted'));
		render(PwaInstall);
		await expect.element(page.getByRole('button', { name: 'Install OpenPalm' })).toBeVisible();

		standalone = true;
		for (const listener of displayModeListeners) listener();

		await expect.element(page.getByText('OpenPalm is installed on this device.')).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Install OpenPalm' }))
			.not.toBeInTheDocument();
	});

	test('shows iOS Safari Add to Home Screen guidance when no prompt is available', async () => {
		setNavigatorValue(
			'userAgent',
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'
		);
		setNavigatorValue('platform', 'iPhone');
		setNavigatorValue('maxTouchPoints', 5);

		pwaInstallService.init();
		render(PwaInstall);

		await expect.element(page.getByText(/tap Share, then/i)).toBeVisible();
		await expect.element(page.getByText('Add to Home Screen')).toBeVisible();
	});

	test('removes browser and display-mode listeners when the root service is disposed', () => {
		const removeWindowListener = vi.spyOn(window, 'removeEventListener');
		pwaInstallService.init();

		pwaInstallService.dispose();

		expect(removeWindowListener).toHaveBeenCalledWith('beforeinstallprompt', expect.any(Function));
		expect(removeWindowListener).toHaveBeenCalledWith('appinstalled', expect.any(Function));
		expect(removeDisplayModeListener).toHaveBeenCalledWith('change', expect.any(Function));
	});
});
