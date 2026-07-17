import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import DeviceSettingsNav from './DeviceSettingsNav.svelte';

describe('DeviceSettingsNav', () => {
	test('puts the visible conversation return before exactly two peer destinations', async () => {
		const { container } = render(DeviceSettingsNav, {
			active: 'connections',
			chatReturnHref: '/advanced?session=session/one&assistant=assistant&one'
		});

		const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'));
		expect(links.map((link) => link.textContent?.trim())).toEqual([
			'← Return to conversation',
			'Assistant connections',
			'Voice input & playback'
		]);
		expect(links[0]?.href).toContain('/advanced?session=session/one&assistant=assistant&one');
		await expect
			.element(page.getByRole('link', { name: 'Assistant connections' }))
			.toHaveAttribute('aria-current', 'page');
		expect(container.textContent).not.toMatch(/Host|Admin/);
	});

	test('preserves the exact encoded return locator between device pages', async () => {
		render(DeviceSettingsNav, {
			active: 'voice',
			chatReturnHref: '/advanced?session=session%2Fone&assistant=assistant%26one'
		});

		await expect
			.element(page.getByRole('link', { name: 'Assistant connections' }))
			.toHaveAttribute(
				'href',
				'/connections?returnTo=%2Fadvanced%3Fsession%3Dsession%252Fone%26assistant%3Dassistant%2526one'
			);
		await expect
			.element(page.getByRole('link', { name: 'Voice input & playback' }))
			.toHaveAttribute(
				'href',
				'/settings/voice?returnTo=%2Fadvanced%3Fsession%3Dsession%252Fone%26assistant%3Dassistant%2526one'
			);
	});

	test('keeps every subnav link at least 44px in both dimensions', () => {
		const { container } = render(DeviceSettingsNav, {
			active: 'voice',
			chatReturnHref: '/chat'
		});

		for (const link of container.querySelectorAll('a')) {
			const style = getComputedStyle(link);
			expect(Number.parseFloat(style.minWidth)).toBeGreaterThanOrEqual(44);
			expect(Number.parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
		}
	});
});
