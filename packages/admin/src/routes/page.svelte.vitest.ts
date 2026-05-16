import { describe, expect, it, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { useConsoleGuard, type ConsoleGuard } from '$lib/test-utils/console-guard';
import AdminPage from './admin/+page.svelte';

// Root / now redirects to /chat via +page.ts.
// The admin dashboard has moved to /admin — test it renders without console errors.
describe('/admin/+page.svelte (admin dashboard)', () => {
	let guard: ConsoleGuard;

	afterEach(() => {
		guard?.cleanup();
	});

	it('should render without console errors', async () => {
		guard = useConsoleGuard();
		render(AdminPage);

		// The dashboard renders the auth gate (or dashboard content) — no JS errors expected
		guard.expectNoErrors();
	});
});
