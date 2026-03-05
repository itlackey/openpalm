import { page } from 'vitest/browser';
import { describe, expect, it, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { useConsoleGuard, type ConsoleGuard } from '$lib/test-utils/console-guard';
import Page from './+page.svelte';

const mockData = {
	detectedUserId: 'test_user',
	setupToken: 'test_token'
};

describe('/setup page', () => {
	let guard: ConsoleGuard;

	afterEach(() => {
		guard?.cleanup();
	});

	it('should render setup heading without console errors', async () => {
		guard = useConsoleGuard();
		render(Page, { props: { data: mockData } });

		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeInTheDocument();
		await expect.element(heading).toHaveTextContent('OpenPalm Setup');

		guard.expectNoErrors();
	});

	it('should show wizard subtitle without console errors', async () => {
		guard = useConsoleGuard();
		render(Page, { props: { data: mockData } });

		const description = page.getByText('Configure your OpenPalm stack in a few steps.');
		await expect.element(description).toBeInTheDocument();

		guard.expectNoErrors();
	});

	it('should show step 1 (Admin Token) on initial render', async () => {
		guard = useConsoleGuard();
		render(Page, { props: { data: mockData } });

		const tokenLabel = page.getByText('Choose an admin token');
		await expect.element(tokenLabel).toBeInTheDocument();

		guard.expectNoErrors();
	});

	it('should show step indicators', async () => {
		guard = useConsoleGuard();
		render(Page, { props: { data: mockData } });

		const step1 = page.getByRole('button', { name: 'Step 1: Admin Token' });
		await expect.element(step1).toBeInTheDocument();

		const step2 = page.getByRole('button', { name: 'Step 2: Provider' });
		await expect.element(step2).toBeInTheDocument();

		guard.expectNoErrors();
	});
});
