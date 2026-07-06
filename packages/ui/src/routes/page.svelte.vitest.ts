import { describe, it, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { useConsoleGuard, type ConsoleGuard } from '$lib/test-utils/console-guard';
import HostPage from './host/+page.svelte';

// Root / now redirects via resolveLanding (hooks + +page.server.ts).
// The host dashboard lives at /host (Phase 4) — test it renders without console errors.
describe('/host/+page.svelte (host dashboard)', () => {
	let guard: ConsoleGuard;

	afterEach(() => {
		guard?.cleanup();
	});

	it('should render without console errors', async () => {
		guard = useConsoleGuard();
		render(HostPage);

		// The dashboard renders the auth gate (or dashboard content) — no JS errors expected
		guard.expectNoErrors();
	});
});
