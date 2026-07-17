import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { ProviderView } from '$lib/types/providers.js';
import AddProviderSheet from './AddProviderSheet.svelte';

const providers = [
	{
		id: 'openai',
		name: 'OpenAI',
		source: 'opencode',
		env: [],
		connected: false,
		configured: false,
		disabled: false,
		activeMainModel: false,
		activeSmallModel: false,
		recommendedModelId: '',
		modelCount: 0,
		models: [],
		authMethods: [],
		options: {},
		supportsOauth: false,
		supportsApiAuth: true
	}
] satisfies ProviderView[];

function renderSheet(onclose = vi.fn()) {
	return {
		onclose,
		result: render(AddProviderSheet, {
			props: { providers, onselect: vi.fn(), oncustom: vi.fn(), onclose }
		})
	};
}

describe('AddProviderSheet accessibility', () => {
	test('has a visible label for provider search and moves focus to it', async () => {
		renderSheet();

		const search = page.getByRole('searchbox', { name: 'Search providers' });
		await expect.element(page.getByText('Search providers', { exact: true })).toBeVisible();
		await expect.element(search).toHaveFocus();
	});

	test('traps focus and closes with Escape', async () => {
		const { onclose } = renderSheet();
		const search = page.getByRole('searchbox', { name: 'Search providers' });
		const close = page.getByRole('button', { name: 'Close' });

		await expect.element(search).toHaveFocus();
		await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
		await expect.element(close).toHaveFocus();
		await userEvent.keyboard('{Escape}');

		expect(onclose).toHaveBeenCalledOnce();
	});
});
