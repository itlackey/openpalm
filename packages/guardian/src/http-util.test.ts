/**
 * Shared HTTP helpers: json() response builder and asRecord() narrowing.
 *
 * Standalone unit test — imports the functions under test directly, spawns no
 * guardian subprocess, so it runs deterministically.
 */
import { describe, expect, it } from 'bun:test';

import { asRecord, json, readJsonBounded, readTextBounded } from './http-util.ts';

describe('json', () => {
	it('sets the given status code', () => {
		expect(json(200, {}).status).toBe(200);
		expect(json(404, {}).status).toBe(404);
		expect(json(502, {}).status).toBe(502);
	});

	it('sets Content-Type to application/json', () => {
		expect(json(200, {}).headers.get('content-type')).toBe('application/json');
	});

	it('round-trips the body via JSON.stringify', async () => {
		const data = { ok: true, items: [1, 2, 3], nested: { a: 'b' } };
		const res = json(201, data);
		expect(await res.text()).toBe(JSON.stringify(data));
		expect(await json(200, data).json()).toEqual(data);
	});
});

describe('asRecord', () => {
	it('returns the value unchanged for plain objects', () => {
		const obj = { a: 1 };
		expect(asRecord(obj)).toBe(obj);
		expect(asRecord({})).toEqual({});
	});

	it('returns null for non-record values', () => {
		expect(asRecord(null)).toBeNull();
		expect(asRecord(undefined)).toBeNull();
		expect(asRecord([1, 2, 3])).toBeNull();
		expect(asRecord('str')).toBeNull();
		expect(asRecord(42)).toBeNull();
		expect(asRecord(true)).toBeNull();
	});
});

describe('bounded response readers', () => {
	it('parses JSON below the byte limit', async () => {
		expect(await readJsonBounded(Response.json({ ok: true }), 64)).toEqual({ ok: true });
	});

	it('rejects declared and streamed bodies above the byte limit', async () => {
		await expect(
			readTextBounded(new Response('small', { headers: { 'content-length': '100' } }), 10)
		).rejects.toThrow('upstream response too large');
		await expect(readTextBounded(new Response('this is too large'), 4)).rejects.toThrow(
			'upstream response too large'
		);
	});
});
