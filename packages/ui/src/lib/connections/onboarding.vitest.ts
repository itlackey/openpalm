import { describe, expect, test, vi } from 'vitest';
import {
	pairingFragment,
	type SaveVerifiedConnectionDependencies,
	saveVerifiedConnection,
	type VerifiedConnectionCandidate,
	verifyConnectionCandidate
} from './onboarding.js';
import type { SecretStore } from './secrets.js';
import type { Connection, ConnectionStore } from './store.js';

function verified(
	overrides: Partial<Omit<VerifiedConnectionCandidate, 'verification'>> = {}
): VerifiedConnectionCandidate {
	return {
		verification: 'verified',
		label: 'Home',
		baseUrl: 'https://guardian.example/oc',
		auth: { mode: 'basic', username: 'phone', password: 'pair-secret' },
		...overrides
	};
}

function transactionHarness(
	options: { previousActive?: string | null; failAt?: string; cleanupFailAt?: string } = {}
) {
	const calls: string[] = [];
	const entries = new Map<string, Connection>();
	const previousActive = options.previousActive === undefined ? 'previous' : options.previousActive;
	if (previousActive) {
		entries.set(previousActive, {
			id: previousActive,
			label: 'Previous',
			baseUrl: 'https://previous.example',
			auth: { mode: 'none' }
		});
	}
	let activeId = previousActive;
	let forwardFailureUsed = false;
	const maybeFail = (name: string): void => {
		if (options.cleanupFailAt === name || (options.failAt === name && !forwardFailureUsed)) {
			if (options.failAt === name) forwardFailureUsed = true;
			throw new Error(`sensitive failure at ${name}`);
		}
	};

	const store = {
		async getActiveId() {
			calls.push('getActiveId');
			return activeId;
		},
		async add(input: Parameters<ConnectionStore['add']>[0]) {
			calls.push('connection:add');
			const entry = { ...input, id: input.id ?? 'generated' } as Connection;
			maybeFail('connection:add');
			entries.set(entry.id, entry);
			return entry;
		},
		async remove(id: string) {
			calls.push(`connection:remove:${id}`);
			const removed = entries.get(id);
			if (!removed) throw new Error(`Unknown connection: ${id}`);
			entries.delete(id);
			if (activeId === id) activeId = null;
			maybeFail('connection:remove');
			return removed;
		},
		async setActive(id: string) {
			calls.push(`active:set:${id}`);
			activeId = id;
			maybeFail('active:set');
		},
		async compareAndSetActive(expected: string | null, id: string | null) {
			calls.push(`active:compare:${expected ?? 'null'}:${id ?? 'null'}`);
			if (activeId !== expected) return false;
			activeId = id;
			maybeFail('active:compare');
			return true;
		},
		async clearActive() {
			calls.push('active:clear');
			activeId = null;
			maybeFail('active:clear');
		}
	};
	const secrets = {
		async set(ref: string) {
			calls.push(`secret:set:${ref}`);
			maybeFail('secret:set');
		},
		async delete(ref: string) {
			calls.push(`secret:delete:${ref}`);
			maybeFail('secret:delete');
		}
	};
	const deps: SaveVerifiedConnectionDependencies = {
		store,
		secrets: secrets as Pick<SecretStore, 'set' | 'delete'>,
		async activate(id, expectedActiveId) {
			calls.push(`activate:${id}${expectedActiveId === undefined ? '' : `:${expectedActiveId}`}`);
			if (expectedActiveId !== undefined && activeId !== expectedActiveId) return;
			activeId = id;
			maybeFail('activate');
		},
		async refresh() {
			calls.push('refresh');
			maybeFail('refresh');
		},
		createId: vi.fn().mockReturnValueOnce('connection-new').mockReturnValueOnce('secret-new')
	};
	return {
		calls,
		entries,
		deps,
		activeId: () => activeId,
		select(id: string) {
			activeId = id;
		}
	};
}

describe('verifyConnectionCandidate', () => {
	test('validates and canonicalizes before the browser probe', async () => {
		const fetch = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
		const result = await verifyConnectionCandidate(
			{
				label: '  Home  ',
				baseUrl: 'https://assistant.example/',
				auth: { mode: 'none' }
			},
			fetch as unknown as typeof globalThis.fetch
		);
		expect(result).toEqual({
			ok: true,
			candidate: {
				verification: 'verified',
				label: 'Home',
				baseUrl: 'https://assistant.example',
				auth: { mode: 'none' }
			}
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	test('rejects query-bearing URLs without network or persistence and returns no input values', async () => {
		const fetch = vi.fn();
		const result = await verifyConnectionCandidate(
			{
				label: 'Private label',
				baseUrl: 'https://private.example?credential=secret',
				auth: { mode: 'basic', username: 'private-user', password: 'private-password' }
			},
			fetch as unknown as typeof globalThis.fetch
		);
		expect(result.ok).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toMatch(
			/Private label|private\.example|private-user|private-password|credential/
		);
	});

	test.each([
		[401, 'credentials-rejected', /credentials/i],
		[404, 'wrong-endpoint', /address/i],
		[429, 'rate-limited', /wait/i],
		[503, 'target-not-ready', /not ready/i]
	] as const)('maps HTTP %i to safe %s guidance', async (status, reason, message) => {
		const fetch = vi.fn().mockResolvedValue(new Response('', { status }));
		const result = await verifyConnectionCandidate(
			{ label: 'Home', baseUrl: 'https://assistant.example', auth: { mode: 'none' } },
			fetch as unknown as typeof globalThis.fetch
		);
		expect(result).toMatchObject({ ok: false, reason, message: expect.stringMatching(message) });
	});
});

describe('saveVerifiedConnection', () => {
	test('writes the secret and connection, activates through the existing path, then refreshes', async () => {
		const harness = transactionHarness();
		const result = await saveVerifiedConnection(verified(), harness.deps);
		expect(result).toMatchObject({ ok: true, connection: { id: 'connection-new' } });
		expect(harness.calls).toEqual([
			'getActiveId',
			'secret:set:secret-new',
			'connection:add',
			'activate:connection-new',
			'refresh'
		]);
		const saved = harness.entries.get('connection-new');
		expect(saved?.auth).toEqual({
			mode: 'basic',
			username: 'phone',
			secretRef: 'secret-new'
		});
		expect(JSON.stringify(saved)).not.toContain('pair-secret');
	});

	test.each([
		'secret:set',
		'connection:add',
		'activate',
		'refresh'
	])('rolls back all attempted artifacts and restores the previous active id when %s fails', async (failAt) => {
		const harness = transactionHarness({ failAt });
		const result = await saveVerifiedConnection(verified(), harness.deps);
		expect(result).toEqual({
			ok: false,
			error: 'Could not save this connection. No changes were kept. Try again.'
		});
		expect(harness.entries.has('connection-new')).toBe(false);
		expect(harness.activeId()).toBe('previous');
		if (failAt === 'activate' || failAt === 'refresh') {
			expect(harness.calls).toContain('connection:remove:connection-new');
			expect(harness.calls).toContain('activate:previous:connection-new');
			expect(harness.calls.filter((call) => call === 'refresh').length).toBeGreaterThanOrEqual(1);
		} else {
			expect(harness.calls).not.toContain('connection:remove:connection-new');
		}
		if (failAt === 'connection:add' || failAt === 'activate' || failAt === 'refresh') {
			expect(harness.calls).toContain('secret:delete:secret-new');
		}
		expect(JSON.stringify(result)).not.toContain('sensitive failure');
	});

	test('does not remove an existing connection when add rejects the generated id', async () => {
		const harness = transactionHarness({ failAt: 'connection:add' });
		harness.entries.set('connection-new', {
			id: 'connection-new',
			label: 'Existing',
			baseUrl: 'https://existing.example',
			auth: { mode: 'none' }
		});
		expect(await saveVerifiedConnection(verified(), harness.deps)).toMatchObject({ ok: false });
		expect(harness.calls).not.toContain('connection:remove:connection-new');
		expect(harness.calls).toContain('secret:delete:secret-new');
		expect(harness.entries.get('connection-new')?.label).toBe('Existing');
	});

	test('clears a newly selected active id when there was no previous selection', async () => {
		const harness = transactionHarness({ previousActive: null, failAt: 'refresh' });
		expect(await saveVerifiedConnection(verified(), harness.deps)).toMatchObject({ ok: false });
		expect(harness.activeId()).toBeNull();
		expect(harness.calls).toContain('active:compare:connection-new:null');
	});

	test('attempts every cleanup operation even when individual cleanup operations fail', async () => {
		const harness = transactionHarness({ failAt: 'refresh', cleanupFailAt: 'connection:remove' });
		const result = await saveVerifiedConnection(verified(), harness.deps);
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ error: expect.stringMatching(/cleanup.*incomplete/i) });
		expect(harness.calls).toContain('secret:delete:secret-new');
		expect(harness.calls).toContain('activate:previous:connection-new');
		expect(harness.calls).toContain('refresh');
	});

	test('preserves a newer active selection made while the failed save was in flight', async () => {
		const harness = transactionHarness();
		harness.entries.set('newer', {
			id: 'newer',
			label: 'Newer selection',
			baseUrl: 'https://newer.example',
			auth: { mode: 'none' }
		});
		let refreshCount = 0;
		harness.deps.refresh = async () => {
			harness.calls.push('refresh');
			refreshCount++;
			if (refreshCount === 1) {
				harness.select('newer');
				throw new Error('save refresh failed');
			}
		};

		const result = await saveVerifiedConnection(verified(), harness.deps);

		expect(result).toEqual({
			ok: false,
			error: 'Could not save this connection. No changes were kept. Try again.'
		});
		expect(harness.activeId()).toBe('newer');
		expect(harness.calls).toContain('activate:previous:connection-new');
		expect(harness.calls).not.toContain('active:set:previous');
		expect(harness.entries.has('connection-new')).toBe(false);
		expect(harness.calls).toContain('secret:delete:secret-new');
	});
});

describe('pairingFragment', () => {
	test('reads pair only from the fragment and strips it while preserving query state', () => {
		expect(
			pairingFragment(new URL('https://app.example/connections/new?onboarding=1#pair=secret-code'))
		).toEqual({
			code: 'secret-code',
			cleanPath: '/connections/new?onboarding=1'
		});
		expect(
			pairingFragment(new URL('https://app.example/connections/new?pair=query-secret'))
		).toEqual({
			code: null,
			cleanPath: '/connections/new?pair=query-secret'
		});
	});
});
