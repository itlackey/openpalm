import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Connection } from './connections/store.js';

function connection(id: string): Connection {
	return {
		id,
		label: id.toUpperCase(),
		baseUrl: `https://${id}.example`,
		auth: { mode: 'none' }
	};
}

const records = [connection('alpha'), connection('beta'), connection('gamma')];
let storedActiveId: string | null = null;

const fakeStore = {
	seedFromRuntimeConfig: vi.fn(async () => {}),
	list: vi.fn(async () => records),
	getActiveId: vi.fn(async () => storedActiveId),
	get: vi.fn(async (id: string) => records.find((item) => item.id === id) ?? null),
	setActive: vi.fn(async (id: string) => {
		storedActiveId = id;
	}),
	compareAndSetActive: vi.fn(async (expected: string | null, id: string | null) => {
		if (storedActiveId !== expected) return false;
		storedActiveId = id;
		return true;
	}),
	clearActive: vi.fn(async () => {
		storedActiveId = null;
	})
};

const setActiveConnection = vi.fn();
const emitConnectionActivated = vi.fn<(id: string) => Promise<void>>(async () => {});
const beginConnectionActivation = vi.fn(() => vi.fn());

vi.mock('./connections/boot.js', () => ({
	getConnectionStore: () => fakeStore,
	setActiveConnection
}));
vi.mock('./connections/store.js', () => ({
	loadRuntimeConfig: vi.fn(async () => null)
}));
vi.mock('./connections/discovery.js', () => ({
	discoverLocalAssistant: vi.fn(async () => null)
}));
vi.mock('./connection-events.js', () => ({
	activationBlockReason: () => null,
	beginConnectionActivation,
	emitConnectionActivated
}));

async function freshService() {
	vi.resetModules();
	return (await import('./endpoints-state.svelte.js')).endpointsService;
}

beforeEach(() => {
	storedActiveId = null;
	vi.clearAllMocks();
	fakeStore.list.mockImplementation(async () => records);
	fakeStore.getActiveId.mockImplementation(async () => storedActiveId);
	fakeStore.get.mockImplementation(
		async (id: string) => records.find((item) => item.id === id) ?? null
	);
	fakeStore.setActive.mockImplementation(async (id: string) => {
		storedActiveId = id;
	});
	fakeStore.compareAndSetActive.mockImplementation(
		async (expected: string | null, id: string | null) => {
			if (storedActiveId !== expected) return false;
			storedActiveId = id;
			return true;
		}
	);
	fakeStore.clearActive.mockImplementation(async () => {
		storedActiveId = null;
	});
	emitConnectionActivated.mockResolvedValue(undefined);
	beginConnectionActivation.mockImplementation(() => vi.fn());
});

describe('active connection restoration', () => {
	test.each([
		null,
		'removed'
	])('repairs a %s persisted active id to the first stable record', async (persisted) => {
		storedActiveId = persisted;
		const service = await freshService();

		await service.load(true);

		expect(service.activeId).toBe('alpha');
		expect(fakeStore.setActive).toHaveBeenCalledWith('alpha');
		expect(storedActiveId).toBe('alpha');
		expect(setActiveConnection).toHaveBeenLastCalledWith(records[0]);
	});

	test('clears a stale persisted active id when no records remain', async () => {
		storedActiveId = 'removed';
		fakeStore.list.mockResolvedValueOnce([]);
		const service = await freshService();

		await service.load(true);

		expect(service.activeId).toBe('');
		expect(fakeStore.clearActive).toHaveBeenCalledOnce();
		expect(setActiveConnection).toHaveBeenLastCalledWith(null);
	});
});

describe('overlapping activation', () => {
	test('same-id callers share activation through the completed handoff', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);

		let releaseHandoff: (() => void) | undefined;
		emitConnectionActivated.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseHandoff = resolve;
				})
		);
		const first = service.activate('beta');
		while (!releaseHandoff) await Promise.resolve();
		let secondSettled = false;
		const shared = service.activate('beta');
		expect(shared).toBe(first);
		const second = shared.finally(() => {
			secondSettled = true;
		});
		await Promise.resolve();

		expect(secondSettled).toBe(false);
		expect(fakeStore.setActive).toHaveBeenCalledTimes(1);
		expect(emitConnectionActivated).toHaveBeenCalledTimes(1);

		releaseHandoff();
		await Promise.all([first, second]);
		expect(service.activeId).toBe('beta');
	});

	test('same-id callers share a failed handoff and one rollback', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);
		fakeStore.setActive.mockClear();
		emitConnectionActivated.mockClear();

		let rejectHandoff: ((error: Error) => void) | undefined;
		emitConnectionActivated.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectHandoff = reject;
				})
		);
		const first = service.activate('beta');
		while (!rejectHandoff) await Promise.resolve();
		const second = service.activate('beta');
		expect(second).toBe(first);
		const failure = new Error('handoff failed');
		rejectHandoff(failure);

		await expect(first).rejects.toBe(failure);
		await expect(second).rejects.toBe(failure);
		expect(fakeStore.setActive.mock.calls.map(([id]) => id)).toEqual(['beta']);
		expect(fakeStore.compareAndSetActive).toHaveBeenCalledWith('beta', 'alpha');
		expect(emitConnectionActivated.mock.calls.map(([id]) => id)).toEqual(['beta', 'alpha']);
		expect(service.activeId).toBe('alpha');
	});

	test('adopts an external selection when failed handoff rollback loses its CAS', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);
		fakeStore.setActive.mockClear();
		fakeStore.compareAndSetActive.mockClear();
		setActiveConnection.mockClear();
		emitConnectionActivated.mockClear();

		let rejectHandoff: ((error: Error) => void) | undefined;
		emitConnectionActivated.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectHandoff = reject;
				})
		);
		const failure = new Error('beta handoff failed');
		const activation = service.activate('beta');
		while (!rejectHandoff) await Promise.resolve();
		storedActiveId = 'gamma';
		rejectHandoff(failure);

		await expect(activation).rejects.toBe(failure);
		expect(fakeStore.compareAndSetActive).toHaveBeenCalledWith('beta', 'alpha');
		expect(fakeStore.setActive).not.toHaveBeenCalledWith('alpha');
		expect(storedActiveId).toBe('gamma');
		expect(service.activeId).toBe('gamma');
		expect(setActiveConnection).toHaveBeenLastCalledWith(records[2]);
		expect(emitConnectionActivated.mock.calls.map(([id]) => id)).toEqual(['beta', 'gamma']);
	});

	test('a normal same-id request waits for a conditional activation rollback, then publishes', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);
		fakeStore.setActive.mockClear();
		fakeStore.compareAndSetActive.mockClear();
		emitConnectionActivated.mockClear();

		const failure = new Error('conditional beta handoff failed');
		emitConnectionActivated.mockRejectedValueOnce(failure);
		let releaseRollback: (() => void) | undefined;
		const waitForRollback = async (): Promise<void> => {
			await new Promise<void>((resolve) => {
				releaseRollback = resolve;
			});
		};
		fakeStore.setActive.mockImplementation(async (id: string) => {
			if (id === 'alpha') await waitForRollback();
			storedActiveId = id;
		});
		fakeStore.compareAndSetActive.mockImplementation(
			async (expected: string | null, id: string | null) => {
				if (expected === 'beta' && id === 'alpha') {
					await waitForRollback();
				}
				if (storedActiveId !== expected) return false;
				storedActiveId = id;
				return true;
			}
		);

		const conditional = service.activate('beta', 'alpha');
		while (!releaseRollback) await Promise.resolve();
		let normalSettled = false;
		const normal = service.activate('beta').then(() => {
			normalSettled = true;
		});
		await Promise.resolve();
		const settledBeforeRollback = normalSettled;
		releaseRollback();
		await expect(conditional).rejects.toBe(failure);
		await normal;
		expect(settledBeforeRollback).toBe(false);
		expect(service.activeId).toBe('beta');
		expect(storedActiveId).toBe('beta');
		expect(setActiveConnection).toHaveBeenLastCalledWith(records[1]);
		expect(emitConnectionActivated.mock.calls.map(([id]) => id)).toEqual(['beta', 'beta']);
	});

	test('an older successful activation cannot publish after a newer activation', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);
		setActiveConnection.mockClear();
		emitConnectionActivated.mockClear();

		let releaseBeta: (() => void) | undefined;
		fakeStore.setActive.mockImplementation(async (id: string) => {
			if (id === 'beta') {
				await new Promise<void>((resolve) => {
					releaseBeta = resolve;
				});
			}
			storedActiveId = id;
		});

		const beta = service.activate('beta');
		await Promise.resolve();
		const gamma = service.activate('gamma');
		releaseBeta?.();
		await Promise.all([beta, gamma]);

		expect(service.activeId).toBe('gamma');
		expect(storedActiveId).toBe('gamma');
		expect(setActiveConnection).toHaveBeenCalledTimes(1);
		expect(setActiveConnection).toHaveBeenLastCalledWith(records[2]);
		expect(emitConnectionActivated).toHaveBeenCalledTimes(1);
		expect(emitConnectionActivated).toHaveBeenLastCalledWith('gamma');
	});

	test('a late reload cannot publish an older active snapshot after activation', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);

		let releaseReload: ((id: string | null) => void) | undefined;
		fakeStore.getActiveId.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseReload = resolve;
				})
		);
		const reload = service.load(true);
		await Promise.resolve();
		await service.activate('beta');
		releaseReload?.('alpha');
		await reload;

		expect(service.activeId).toBe('beta');
		expect(storedActiveId).toBe('beta');
		expect(setActiveConnection).toHaveBeenLastCalledWith(records[1]);
	});

	test('a concurrent forced reload cannot clobber an already in-flight activation', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);
		expect(service.activeId).toBe('alpha');
		setActiveConnection.mockClear();

		let releaseActivate: (() => void) | undefined;
		fakeStore.setActive.mockImplementationOnce(
			(id: string) =>
				new Promise<void>((resolve) => {
					releaseActivate = () => {
						storedActiveId = id;
						resolve();
					};
				})
		);

		// Start the activation FIRST and park it on its held setActive write.
		// This bumps activationSeq -> 1, sets activeId='beta', sets
		// pendingActivation, and enqueues the held setActive('beta').
		const activation = service.activate('beta');
		while (!releaseActivate) await Promise.resolve();

		// The activation owns the selection in memory, but its store write is
		// still parked, so storage still reads the stale 'alpha'.
		expect(service.activeId).toBe('beta');
		expect(storedActiveId).toBe('alpha');

		// A forced reload races in while the activation is STILL parked. It sees
		// the stale stored 'alpha' and captures seq=1 (the activation already did
		// its single ++ before this load captured it), so both seq re-checks pass
		// 1===1. Without the pendingActivation gate it republishes the stale
		// 'alpha', clobbering the in-flight activation. Do NOT release/await the
		// activation first — that would clear pendingActivation and mask the bug.
		await service.load(true);

		// Capture the discriminators WHILE the activation is still in flight, but
		// do not assert yet: releasing/awaiting the activation below must run
		// unconditionally so a red (unfixed) run fails on a clean assertion
		// instead of hanging on the still-parked activation promise.
		const activeIdDuringActivation = service.activeId;
		const endpointsAfterReload = service.endpoints.map((endpoint) => endpoint.id);

		releaseActivate();
		await activation;

		// The fix-vs-unfixed discriminator: the in-flight activation must remain
		// the sole authority on active selection. RED without the fix (the reload
		// republishes the stale 'alpha' over the just-activated 'beta').
		expect(activeIdDuringActivation).toBe('beta');
		// The reload must still refresh the endpoint list unconditionally, even
		// while its active-state publish is suppressed by the gate.
		expect(endpointsAfterReload).toEqual(['alpha', 'beta', 'gamma']);
		// Memory, transport, and storage all agree on the activated connection.
		expect(service.activeId).toBe('beta');
		expect(storedActiveId).toBe('beta');
		expect(setActiveConnection).toHaveBeenLastCalledWith(records[1]);
	});

	test('a same-id reload during an in-flight activation refreshes the connection record', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);

		// Put an activation in flight and hold it on its handoff so activeId and
		// storedActiveId are already 'beta' while it awaits — the window in which
		// the user can edit the connection being activated.
		let releaseHandoff: (() => void) | undefined;
		emitConnectionActivated.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseHandoff = resolve;
				})
		);
		const activation = service.activate('beta');
		while (!releaseHandoff) await Promise.resolve();
		expect(service.activeId).toBe('beta');
		expect(storedActiveId).toBe('beta');
		setActiveConnection.mockClear();

		// The active connection (beta) is edited; the settings save path reloads.
		const editedBeta: Connection = {
			...connection('beta'),
			baseUrl: 'https://beta-edited.example'
		};
		fakeStore.list.mockResolvedValueOnce([records[0], editedBeta, records[2]]);
		await service.load(true);

		// Capture before releasing so a regression fails on a clean assertion
		// rather than hanging on the still-parked activation.
		const transportAfterReload = setActiveConnection.mock.calls.at(-1)?.[0];
		const activeIdAfterReload = service.activeId;
		const betaUrlAfterReload = service.endpoints.find((endpoint) => endpoint.id === 'beta')?.url;

		releaseHandoff();
		await activation;

		// A same-id reload must not change the selection, but MUST refresh the
		// transport snapshot so direct requests pick up the edited record.
		expect(activeIdAfterReload).toBe('beta');
		expect(transportAfterReload).toEqual(editedBeta);
		expect(betaUrlAfterReload).toBe('https://beta-edited.example');
		expect(service.activeId).toBe('beta');
		expect(storedActiveId).toBe('beta');
	});

	test('a failing superseding activation rolls back to the last published connection', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);
		setActiveConnection.mockClear();
		emitConnectionActivated.mockImplementation(async (id: string) => {
			if (id === 'gamma') throw new Error('gamma handoff failed');
		});

		let releaseBeta: (() => void) | undefined;
		fakeStore.setActive.mockImplementation(async (id: string) => {
			if (id === 'beta') {
				await new Promise<void>((resolve) => {
					releaseBeta = resolve;
				});
			}
			storedActiveId = id;
		});

		const beta = service.activate('beta');
		while (!releaseBeta) await Promise.resolve();
		const gamma = service.activate('gamma');
		releaseBeta();
		const outcomes = await Promise.allSettled([beta, gamma]);

		expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
		expect(service.activeId).toBe('alpha');
		expect(storedActiveId).toBe('alpha');
		expect(fakeStore.compareAndSetActive).toHaveBeenCalledWith('gamma', 'alpha');
		expect(setActiveConnection).toHaveBeenLastCalledWith(records[0]);
		expect(emitConnectionActivated.mock.calls.map(([id]) => id)).toEqual(['gamma', 'alpha']);
	});

	test('coalesces a forced reload behind stale in-flight work and publishes its newer snapshot', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);
		fakeStore.list.mockClear();
		setActiveConnection.mockClear();

		let releaseStale: ((connections: Connection[]) => void) | undefined;
		fakeStore.list
			.mockImplementationOnce(
				() =>
					new Promise<Connection[]>((resolve) => {
						releaseStale = resolve;
					})
			)
			.mockImplementation(async () => records);
		const stale = service.load(true);
		while (!releaseStale) await Promise.resolve();
		storedActiveId = 'beta';
		const forced = service.load(true);
		releaseStale([records[0]]);
		await Promise.all([stale, forced]);

		expect(fakeStore.list).toHaveBeenCalledTimes(2);
		expect(service.endpoints.map((endpoint) => endpoint.id)).toEqual(['alpha', 'beta', 'gamma']);
		expect(service.activeId).toBe('beta');
		expect(setActiveConnection).toHaveBeenLastCalledWith(records[1]);
	});

	test('queues a new forced reload requested while the trailing forced reload is running', async () => {
		storedActiveId = 'alpha';
		const service = await freshService();
		await service.load(true);
		fakeStore.list.mockClear();

		let releaseInitial: ((connections: Connection[]) => void) | undefined;
		let releaseFirstForce: ((connections: Connection[]) => void) | undefined;
		fakeStore.list
			.mockImplementationOnce(
				() =>
					new Promise<Connection[]>((resolve) => {
						releaseInitial = resolve;
					})
			)
			.mockImplementationOnce(
				() =>
					new Promise<Connection[]>((resolve) => {
						releaseFirstForce = resolve;
					})
			)
			.mockResolvedValueOnce([records[2]]);

		const initial = service.load(true);
		while (!releaseInitial) await Promise.resolve();
		const firstForce = service.load(true);
		releaseInitial([records[0]]);
		while (!releaseFirstForce) await Promise.resolve();
		storedActiveId = 'gamma';
		const secondForce = service.load(true);
		releaseFirstForce([records[1]]);
		await Promise.all([initial, firstForce, secondForce]);

		expect(fakeStore.list).toHaveBeenCalledTimes(3);
		expect(service.endpoints.map((endpoint) => endpoint.id)).toEqual(['gamma']);
		expect(service.activeId).toBe('gamma');
	});
});
