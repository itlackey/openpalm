import { afterEach, describe, expect, test, vi } from 'vitest';
import { applyChanges, applyServiceUpdate } from './versions.js';

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
