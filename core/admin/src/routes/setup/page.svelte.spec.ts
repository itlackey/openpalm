import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';

const mockData = {
	detectedUserId: 'test_user',
	setupToken: 'test_token'
};

describe('/setup page', () => {
	it('should render setup heading', async () => {
		render(Page, { props: { data: mockData } });

		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeInTheDocument();
		await expect.element(heading).toHaveTextContent('OpenPalm Setup');
	});

	it('should show wizard subtitle', async () => {
		render(Page, { props: { data: mockData } });

		const description = page.getByText('Configure your OpenPalm stack in a few steps.');
		await expect.element(description).toBeInTheDocument();
	});
});
