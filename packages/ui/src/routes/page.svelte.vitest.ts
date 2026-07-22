import { describe, expect, it, afterEach, vi } from 'vitest';
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
		vi.unstubAllGlobals();
	});

	it('should render without console errors', async () => {
		const responses: Record<string, unknown> = {
			'/api/runtime-config': { connections: [] },
			'/health': { status: 'ok', service: 'admin' },
			'/guardian/health': { status: 'ok', service: 'guardian' },
			'/api/host/containers/list': {
				containers: {},
				dockerContainers: [],
				dockerAvailable: true,
				managedServices: []
			},
			'/api/host/automations': { automations: [] },
			'/api/host/akm/health': {
				available: true,
				status: 'ok',
				ok: true,
				checks: { pass: 1, warn: 0, fail: 0 },
				metrics: null,
				index: null
			}
		};
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const pathname = new URL(String(input), window.location.href).pathname;
			if (!(pathname in responses)) throw new Error(`Unexpected request: ${pathname}`);
			return new Response(JSON.stringify(responses[pathname]), {
				headers: { 'content-type': 'application/json' }
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		guard = useConsoleGuard();
		const view = render(HostPage);

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
		await vi.waitFor(() => expect(view.container.textContent).toContain('Healthy'));

		// The dashboard renders the auth gate (or dashboard content) — no JS errors expected
		guard.expectNoErrors();
	});
});
