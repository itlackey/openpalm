import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import DeviceSettingsNav from './DeviceSettingsNav.svelte';

describe('DeviceSettingsNav', () => {
	test('puts the conversation return before the three settings sections', async () => {
		const { container } = render(DeviceSettingsNav, {
			chatReturnHref: '/advanced?session=session/one&assistant=assistant&one'
		});

		const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'));
		expect(links.map((link) => link.textContent?.trim())).toEqual([
			'← Return to conversation',
			'Connections',
			'Voice',
			'Appearance'
		]);
		expect(links[0]?.href).toContain('/advanced?session=session/one&assistant=assistant&one');
		await expect.element(page.getByRole('link', { name: 'Connections' })).toHaveAttribute('href', '#connections');
		await expect.element(page.getByRole('link', { name: 'Voice' })).toHaveAttribute('href', '#voice');
		await expect.element(page.getByRole('link', { name: 'Appearance' })).toHaveAttribute('href', '#appearance');
	});

	test('keeps every subnav link at least 44px in both dimensions', () => {
		const { container } = render(DeviceSettingsNav, {
			chatReturnHref: '/chat'
		});

		for (const link of container.querySelectorAll('a')) {
			const style = getComputedStyle(link);
			expect(Number.parseFloat(style.minWidth)).toBeGreaterThanOrEqual(44);
			expect(Number.parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
		}
	});
});
