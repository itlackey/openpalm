import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';

describe('/setup page', () => {
	it('should render setup heading', async () => {
		render(Page);

		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeInTheDocument();
		await expect.element(heading).toHaveTextContent('OpenPalm Setup');
	});

	it('should show wizard subtitle', async () => {
		render(Page);

		const description = page.getByText('Configure your OpenPalm stack in a few steps.');
		await expect.element(description).toBeInTheDocument();
	});
});
