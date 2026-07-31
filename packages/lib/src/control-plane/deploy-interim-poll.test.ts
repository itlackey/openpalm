/**
 * D6: the interim deploy poll (`startInterimStatusPoll`) used to treat ANY
 * non-empty `compose ps` result as evidence the new `up` was progressing. On
 * a redeploy the OLD containers from the PREVIOUS `up` are often still
 * present (and already healthy) while the new `up` is still pulling images —
 * the first poll tick would see those stale rows, flip the phase from
 * 'pulling-images' to 'starting', and mark their rows 'Running' before a
 * single new container existed.
 *
 * `newlyObservedRows` is the pure decision this was split out into: every `up`
 * this codebase issues passes `--force-recreate` (docker.ts), so a service
 * that genuinely (re)started always gets a NEW container ID. Comparing
 * against a pre-`up` baseline tells a fresh container apart from a stale one
 * without a running docker daemon or the poll's 5s interval.
 */
import { describe, expect, it } from 'bun:test';
import { newlyObservedRows } from './deploy.js';
import type { ComposePsRow } from './docker.js';

function row(service: string, id: string, state = 'running', health = ''): ComposePsRow {
	return { service, id, state, health };
}

describe('newlyObservedRows', () => {
	it('drops a row whose id matches its baseline (the stale, pre-redeploy container)', () => {
		const baseline = new Map([['assistant', 'old-id']]);
		const rows = [row('assistant', 'old-id')];

		expect(newlyObservedRows(rows, baseline)).toEqual([]);
	});

	it('keeps a row whose id differs from its baseline (force-recreate produced a new container)', () => {
		const baseline = new Map([['assistant', 'old-id']]);
		const rows = [row('assistant', 'new-id')];

		expect(newlyObservedRows(rows, baseline)).toEqual(rows);
	});

	it('keeps a row for a service absent from the baseline (freshly added, e.g. a newly enabled addon)', () => {
		const baseline = new Map<string, string>();
		const rows = [row('discord', 'brand-new-id')];

		expect(newlyObservedRows(rows, baseline)).toEqual(rows);
	});

	it('keeps a row with no id at all — nothing to compare, so it is trusted rather than discarded forever', () => {
		const baseline = new Map([['assistant', 'old-id']]);
		const rows = [row('assistant', '')];

		expect(newlyObservedRows(rows, baseline)).toEqual(rows);
	});

	it('on a mixed redeploy, only the actually-recreated services count as progress', () => {
		const baseline = new Map([
			['assistant', 'assistant-old'],
			['guardian', 'guardian-old'],
		]);
		const rows = [
			row('assistant', 'assistant-old'), // stale — still the pre-redeploy container
			row('guardian', 'guardian-new'), // recreated already
		];

		expect(newlyObservedRows(rows, baseline)).toEqual([row('guardian', 'guardian-new')]);
	});
});
