import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';

describe('/setup page', () => {
	it('should render auth gate heading on mount', async () => {
		render(Page);

		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeInTheDocument();
		await expect.element(heading).toHaveTextContent('OpenPalm Setup');
	});

	it('should show admin token input', async () => {
		render(Page);

		const tokenInput = page.getByLabelText('Admin Token');
		await expect.element(tokenInput).toBeInTheDocument();
	});

	it('should have a submit button labeled Continue', async () => {
		render(Page);

		const button = page.getByRole('button', { name: 'Continue' });
		await expect.element(button).toBeInTheDocument();
	});

	it('should display login description text', async () => {
		render(Page);

		const description = page.getByText('Enter your admin token to begin setup.');
		await expect.element(description).toBeInTheDocument();
	});
});
