import { describe, expect, it } from 'bun:test';
import { setBoundedMapEntry } from './bounded-map.ts';

describe('setBoundedMapEntry', () => {
	it('evicts the oldest key before adding beyond the cap', () => {
		const map = new Map<string, number>();
		setBoundedMapEntry(map, 'a', 1, 2);
		setBoundedMapEntry(map, 'b', 2, 2);
		setBoundedMapEntry(map, 'c', 3, 2);
		expect([...map.entries()]).toEqual([
			['b', 2],
			['c', 3]
		]);
	});

	it('updates an existing key without evicting another entry', () => {
		const map = new Map<string, number>([
			['a', 1],
			['b', 2]
		]);
		setBoundedMapEntry(map, 'a', 3, 2);
		expect([...map.entries()]).toEqual([
			['a', 3],
			['b', 2]
		]);
	});
});
