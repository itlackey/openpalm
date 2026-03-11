import { page } from 'vitest/browser';
import { describe, expect, it, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { useConsoleGuard, type ConsoleGuard } from '$lib/test-utils/console-guard';
import Page from './+page.svelte';

describe('/+page.svelte', () => {
	let guard: ConsoleGuard;

	afterEach(() => {
		guard?.cleanup();
	});

	it('should render h1 without console errors', async () => {
		guard = useConsoleGuard();
		render(Page);

		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeInTheDocument();

		guard.expectNoErrors();
	});
});
