import { afterEach, describe, expect, test, vi } from 'vitest';
import { applyChanges, applyServiceUpdate, clearRollbackPin, isRollbackPin } from './versions.js';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('update client', () => {
	test('sends only the real Compose service', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(applyServiceUpdate('discord')).resolves.toBeUndefined();
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ service: 'discord' });
	});

	test('sends an empty body for a stack update', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await applyChanges();

		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({});
	});

	test('throws the server message for non-success responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({ error: 'docker_unavailable', message: 'Docker is unavailable' }),
					{ status: 503, headers: { 'content-type': 'application/json' } }
				)
			)
		);

		await expect(applyServiceUpdate('assistant')).rejects.toThrow('Docker is unavailable');
	});
});

// #639 — distinguishing a rollback-generation-* pin (never operator-typed)
// from any other configured value.
describe('isRollbackPin', () => {
	test('is true only for the rollback-generation- prefix', () => {
		expect(isRollbackPin('rollback-generation-1788212586188-217761-1')).toBe(true);
		expect(isRollbackPin('rollback-generation-1')).toBe(true);
	});

	test('is false for a release tag, a moving tag, a custom pin, or an unset value', () => {
		expect(isRollbackPin('0.13.1')).toBe(false);
		expect(isRollbackPin('latest')).toBe(false);
		expect(isRollbackPin('my-custom-build')).toBe(false);
		expect(isRollbackPin(undefined)).toBe(false);
	});
});

describe('clearRollbackPin', () => {
	test('POSTs to the dedicated clear-rollback-pin action and returns what was cleared', async () => {
		const cleared = { OP_ASSISTANT_VERSION: { from: 'rollback-generation-1', to: '0.13.1' } };
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true, cleared }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await clearRollbackPin();

		expect(result.cleared).toEqual(cleared);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toContain('/api/host/versions/clear-rollback-pin');
		expect(init.method).toBe('POST');
	});

	test('throws the server message for non-success responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'clear_rollback_pin_failed', message: 'boom' }), {
					status: 500,
					headers: { 'content-type': 'application/json' }
				})
			)
		);

		await expect(clearRollbackPin()).rejects.toThrow('boom');
	});
});
