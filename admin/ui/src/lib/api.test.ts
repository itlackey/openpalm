import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock fetch and window.location per test
describe('api module', () => {
	let originalFetch: typeof globalThis.fetch;
	let originalLocation: Location;

	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();

		// Save originals
		originalFetch = globalThis.fetch;

		// Mock window.location with a configurable pathname
		originalLocation = window.location;
		Object.defineProperty(window, 'location', {
			writable: true,
			value: { ...originalLocation, pathname: '/' }
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		Object.defineProperty(window, 'location', {
			writable: true,
			value: originalLocation
		});
	});

	function mockFetch(response: { ok: boolean; status: number; body: string }) {
		const fn = vi.fn().mockResolvedValue({
			ok: response.ok,
			status: response.status,
			text: () => Promise.resolve(response.body)
		});
		globalThis.fetch = fn;
		return fn;
	}

	// --- apiGet ---

	it('apiGet makes a GET request to the correct URL', async () => {
		const fetchMock = mockFetch({ ok: true, status: 200, body: '{"result":"ok"}' });
		const { apiGet } = await import('./api');

		const result = await apiGet('/admin/health');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/admin/health');
		expect(opts.method).toBe('GET');
		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(result.data).toEqual({ result: 'ok' });
	});

	// --- apiPost ---

	it('apiPost makes a POST request with JSON body', async () => {
		const fetchMock = mockFetch({ ok: true, status: 200, body: '{"created":true}' });
		const { apiPost } = await import('./api');

		const result = await apiPost('/admin/items', { name: 'test' });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/admin/items');
		expect(opts.method).toBe('POST');
		expect(opts.body).toBe(JSON.stringify({ name: 'test' }));
		expect(opts.headers['content-type']).toBe('application/json');
		expect(result.data).toEqual({ created: true });
	});

	it('apiPost sends no body when body argument is undefined', async () => {
		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });
		const { apiPost } = await import('./api');

		await apiPost('/admin/action');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.body).toBeUndefined();
	});

	// --- Auth token header ---

	it('includes x-admin-token header when auth token is set', async () => {
		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });

		// Set token in localStorage before importing the module
		localStorage.setItem('op_admin', 'secret-token-abc');
		const { apiGet } = await import('./api');

		await apiGet('/admin/data');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers['x-admin-token']).toBe('secret-token-abc');
	});

	it('does not include x-admin-token header when no token is set', async () => {
		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });
		const { apiGet } = await import('./api');

		await apiGet('/admin/data');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers['x-admin-token']).toBeUndefined();
	});

	it('does not include x-admin-token header when noAuth option is true', async () => {
		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });
		localStorage.setItem('op_admin', 'secret-token-abc');
		const { apiGet } = await import('./api');

		await apiGet('/admin/data', { noAuth: true });

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers['x-admin-token']).toBeUndefined();
	});

	// --- URL construction (behind Caddy) ---

	it('rewrites path when behind Caddy (/admin prefix on pathname)', async () => {
		Object.defineProperty(window, 'location', {
			writable: true,
			value: { ...originalLocation, pathname: '/admin/dashboard' }
		});

		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });
		const { apiGet } = await import('./api');

		await apiGet('/admin/health');

		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/admin/api/health');
	});

	it('does not rewrite path when not behind Caddy', async () => {
		Object.defineProperty(window, 'location', {
			writable: true,
			value: { ...originalLocation, pathname: '/dashboard' }
		});

		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });
		const { apiGet } = await import('./api');

		await apiGet('/admin/health');

		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/admin/health');
	});

	it('does not double-rewrite path that already has /admin/api/ prefix', async () => {
		Object.defineProperty(window, 'location', {
			writable: true,
			value: { ...originalLocation, pathname: '/admin/something' }
		});

		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });
		const { apiGet } = await import('./api');

		await apiGet('/admin/api/health');

		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/admin/api/health');
	});

	it('passes through non-admin paths unchanged even behind Caddy', async () => {
		Object.defineProperty(window, 'location', {
			writable: true,
			value: { ...originalLocation, pathname: '/admin/ui' }
		});

		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });
		const { apiGet } = await import('./api');

		await apiGet('/other/endpoint');

		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/other/endpoint');
	});

	// --- Error handling ---

	it('returns ok: false for non-ok HTTP responses', async () => {
		mockFetch({ ok: false, status: 403, body: '{"error":"forbidden"}' });
		const { apiGet } = await import('./api');

		const result = await apiGet('/admin/secret');

		expect(result.ok).toBe(false);
		expect(result.status).toBe(403);
		expect(result.data).toEqual({ error: 'forbidden' });
	});

	it('returns status 0 and error message when fetch throws (network error)', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
		const { apiGet } = await import('./api');

		const result = await apiGet('/admin/data');

		expect(result.ok).toBe(false);
		expect(result.status).toBe(0);
		expect((result.data as { error: string }).error).toBe(
			'Server unreachable. Check that OpenPalm is running.'
		);
	});

	it('returns raw text when response body is not valid JSON', async () => {
		mockFetch({ ok: true, status: 200, body: 'plain text response' });
		const { apiGet } = await import('./api');

		const result = await apiGet('/admin/text-endpoint');

		expect(result.ok).toBe(true);
		expect(result.data).toBe('plain text response');
	});

	// --- apiGetText ---

	it('apiGetText returns raw text data', async () => {
		const fetchMock = mockFetch({ ok: true, status: 200, body: 'key: value\nfoo: bar' });
		localStorage.setItem('op_admin', 'my-token');
		const { apiGetText } = await import('./api');

		const result = await apiGetText('/admin/config');

		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(result.data).toBe('key: value\nfoo: bar');

		// Should include auth header
		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers['x-admin-token']).toBe('my-token');
	});

	it('apiGetText returns empty string on network error', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'));
		const { apiGetText } = await import('./api');

		const result = await apiGetText('/admin/config');

		expect(result.ok).toBe(false);
		expect(result.status).toBe(0);
		expect(result.data).toBe('');
	});

	it('apiGetText does not include auth header when no token is set', async () => {
		const fetchMock = mockFetch({ ok: true, status: 200, body: 'data' });
		const { apiGetText } = await import('./api');

		await apiGetText('/admin/config');

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers['x-admin-token']).toBeUndefined();
	});

	// --- 401 handling ---

	it('clears auth token on 401 response when token is set', async () => {
		localStorage.setItem('op_admin', 'my-token');
		mockFetch({ ok: false, status: 401, body: '{"error":"unauthorized"}' });
		const { apiGet } = await import('./api');

		await apiGet('/admin/data');

		// Token should be cleared from localStorage
		expect(localStorage.getItem('op_admin')).toBeNull();
	});

	it('does NOT clear token on 401 when noAuth is true', async () => {
		localStorage.setItem('op_admin', 'my-token');
		mockFetch({ ok: false, status: 401, body: '{"error":"unauthorized"}' });
		const { apiGet } = await import('./api');

		await apiGet('/admin/data', { noAuth: true });

		// Token should NOT be cleared
		expect(localStorage.getItem('op_admin')).toBe('my-token');
	});

	it('does NOT clear token on 401 when no token is set', async () => {
		// No token in localStorage
		mockFetch({ ok: false, status: 401, body: '{"error":"unauthorized"}' });
		const { apiGet } = await import('./api');

		await apiGet('/admin/data');

		// Nothing should crash, token stays absent
		expect(localStorage.getItem('op_admin')).toBeNull();
	});

	it('does NOT clear token on non-401 error (e.g. 403)', async () => {
		localStorage.setItem('op_admin', 'my-token');
		mockFetch({ ok: false, status: 403, body: '{"error":"forbidden"}' });
		const { apiGet } = await import('./api');

		await apiGet('/admin/data');

		// Token should NOT be cleared for 403
		expect(localStorage.getItem('op_admin')).toBe('my-token');
	});

	it('apiPost clears token on 401 when token is set', async () => {
		localStorage.setItem('op_admin', 'my-token');
		mockFetch({ ok: false, status: 401, body: '{"error":"unauthorized"}' });
		const { apiPost } = await import('./api');

		await apiPost('/admin/action', { data: 'test' });

		expect(localStorage.getItem('op_admin')).toBeNull();
	});

	it('apiGetText clears token on 401 when token is set', async () => {
		localStorage.setItem('op_admin', 'my-token');
		mockFetch({ ok: false, status: 401, body: 'Unauthorized' });
		const { apiGetText } = await import('./api');

		await apiGetText('/admin/config');

		expect(localStorage.getItem('op_admin')).toBeNull();
	});

	it('apiGetText does NOT clear token on 401 when no token is set', async () => {
		mockFetch({ ok: false, status: 401, body: 'Unauthorized' });
		const { apiGetText } = await import('./api');

		await apiGetText('/admin/config');

		expect(localStorage.getItem('op_admin')).toBeNull();
	});

	// --- apiGetText additional coverage ---

	it('apiGetText returns ok: false with text for non-OK non-401 response', async () => {
		localStorage.setItem('op_admin', 'my-token');
		mockFetch({ ok: false, status: 500, body: 'Internal Server Error' });
		const { apiGetText } = await import('./api');

		const result = await apiGetText('/admin/config');

		expect(result.ok).toBe(false);
		expect(result.status).toBe(500);
		expect(result.data).toBe('Internal Server Error');
		// Token should NOT be cleared for 500
		expect(localStorage.getItem('op_admin')).toBe('my-token');
	});

	it('apiGetText rewrites path when behind Caddy', async () => {
		Object.defineProperty(window, 'location', {
			writable: true,
			value: { ...originalLocation, pathname: '/admin/config' }
		});
		const fetchMock = mockFetch({ ok: true, status: 200, body: 'config text' });
		const { apiGetText } = await import('./api');

		await apiGetText('/admin/config');

		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/admin/api/config');
	});

	// --- Custom headers forwarding ---

	it('custom headers passed via opts are forwarded', async () => {
		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });
		const { apiGet } = await import('./api');

		await apiGet('/admin/data', {
			headers: { 'x-custom': 'custom-value' }
		});

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers['x-custom']).toBe('custom-value');
		expect(opts.headers['content-type']).toBe('application/json');
	});

	it('apiPost with noAuth option does not send auth header', async () => {
		localStorage.setItem('op_admin', 'my-token');
		const fetchMock = mockFetch({ ok: true, status: 200, body: '{}' });
		const { apiPost } = await import('./api');

		await apiPost('/admin/action', { data: 'test' }, { noAuth: true });

		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.headers['x-admin-token']).toBeUndefined();
	});
});
