import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import DeviceSettingsNav from './DeviceSettingsNav.svelte';

describe('DeviceSettingsNav', () => {
	test('renders only the two shared-style device settings tabs', async () => {
		const onTabChange = vi.fn();
		const { container } = await render(DeviceSettingsNav, {
			activeTab: 'general',
			onTabChange
		});

		expect(container.querySelectorAll('a')).toHaveLength(0);
		const tabs = Array.from(
			container.querySelectorAll<HTMLButtonElement>('[aria-label="Settings tabs"] [role="tab"]')
		);
		expect(container.querySelector('[aria-label="Sections"]')).toBeNull();
		expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['General', 'Connections']);
		expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
		expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
		tabs[1]?.click();
		expect(onTabChange).toHaveBeenCalledWith('connections');
	});

	test('uses the same mobile selector as host navigation', async () => {
		await render(DeviceSettingsNav, {
			activeTab: 'connections',
			onTabChange: vi.fn()
		});

		const select = page.getByLabelText('Settings page');
		await expect.element(select).toBeVisible();
		await expect.element(select).toHaveValue('connections');
		expect(Number.parseFloat(getComputedStyle(select.element()).minHeight)).toBeGreaterThanOrEqual(44);
	});

	test('selects a settings destination from the shared mobile navigator', async () => {
		const onTabChange = vi.fn();
		await render(DeviceSettingsNav, {
			activeTab: 'general',
			onTabChange
		});

		await page.getByLabelText('Settings page').selectOptions('connections');
		expect(onTabChange).toHaveBeenCalledWith('connections');
	});
});
