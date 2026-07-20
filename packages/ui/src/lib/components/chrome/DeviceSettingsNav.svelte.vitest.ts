import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import DeviceSettingsNav from './DeviceSettingsNav.svelte';

describe('DeviceSettingsNav', () => {
	test('puts the conversation return before the two settings tabs', async () => {
		const onTabChange = vi.fn();
		const { container } = render(DeviceSettingsNav, {
			chatReturnHref: '/advanced?session=session/one&assistant=assistant&one',
			activeTab: 'general',
			onTabChange
		});

		const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'));
		expect(links.map((link) => link.textContent?.trim())).toEqual(['← Return to conversation']);
		expect(links[0]?.href).toContain('/advanced?session=session/one&assistant=assistant&one');
		await expect.element(page.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
		await expect.element(page.getByRole('tab', { name: 'Connections' })).toHaveAttribute('aria-selected', 'false');
		await page.getByRole('tab', { name: 'Connections' }).click();
		expect(onTabChange).toHaveBeenCalledWith('connections');
	});

	test('keeps every subnav target at least 44px in both dimensions', () => {
		const { container } = render(DeviceSettingsNav, {
			chatReturnHref: '/chat',
			activeTab: 'connections',
			onTabChange: vi.fn()
		});

		for (const target of container.querySelectorAll('.nav-target')) {
			const style = getComputedStyle(target);
			expect(Number.parseFloat(style.minWidth)).toBeGreaterThanOrEqual(44);
			expect(Number.parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
		}
	});

	test('supports arrow-key movement between tabs', async () => {
		const onTabChange = vi.fn();
		render(DeviceSettingsNav, {
			chatReturnHref: '/chat',
			activeTab: 'general',
			onTabChange
		});

		await page.getByRole('tab', { name: 'General' }).click();
		await userEvent.keyboard('{ArrowRight}');
		expect(onTabChange).toHaveBeenCalledWith('connections');
	});
});
