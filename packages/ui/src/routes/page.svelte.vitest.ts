import { describe, it, afterEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { useConsoleGuard, type ConsoleGuard } from '$lib/test-utils/console-guard';

vi.mock('$lib/runtime-context.svelte.js', () => ({
	getRuntimeContext: () => ({
		routes: { chat: '/chat', host: '/host' },
		effectiveCapabilities: ['host:stack:read']
	}),
	hasCapability: (context: { effectiveCapabilities: string[] }, capability: string) =>
		context.effectiveCapabilities.includes(capability)
}));

import HostPage from './(app)/host/+page.svelte';

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
