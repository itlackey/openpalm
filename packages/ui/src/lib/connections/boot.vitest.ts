import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ConnectionStorage } from './store.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function fakeStorage(overrides: Partial<ConnectionStorage> = {}): ConnectionStorage {
	return {
		getAll: vi.fn(async () => []),
		get: vi.fn(async () => null),
		put: vi.fn(async () => {}),
		updateConnection: vi.fn(async () => null),
		removeConnectionState: vi.fn(async () => null),
		getMeta: vi.fn(async () => null),
		setMeta: vi.fn(async () => {}),
		setActive: vi.fn(async () => 'target-missing' as const),
		compareAndSetActive: vi.fn(async () => 'mismatch' as const),
		getCryptoKey: vi.fn(async () => null),
		setCryptoKey: vi.fn(async () => {}),
		...overrides
	};
}

async function installStorageDoubles(persistent: ConnectionStorage, memory: ConnectionStorage) {
	const actual = await vi.importActual<typeof import('./store.js')>('./store.js');
	vi.doMock('./store.js', () => ({
		...actual,
		createIndexedDbStorage: () => persistent,
		createMemoryStorage: () => memory
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('./store.js');
	vi.resetModules();
});

describe('connection storage initialization', () => {
	test('falls back to working session-only storage when the initial IndexedDB open fails', async () => {
		vi.stubGlobal('indexedDB', {
			open() {
				const request: Record<string, unknown> = {};
				queueMicrotask(() => {
					(request.onerror as (() => void) | undefined)?.();
				});
				return request;
			}
		});

		const { getConnectionStorageMode, getConnectionStore } = await import('./boot.js');
		await expect(getConnectionStorageMode()).resolves.toBe('session-only');

		const store = getConnectionStore();
		await store.add({
			id: 'session-connection',
			label: 'This session',
			baseUrl: 'https://assistant.example',
			auth: { mode: 'none' }
		});
		expect(await store.list()).toHaveLength(1);
	});

	test('all concurrent first operations share the session-only fallback after an open failure', async () => {
		vi.stubGlobal('indexedDB', {
			open() {
				const request: Record<string, unknown> = {};
				queueMicrotask(() => {
					(request.onerror as (() => void) | undefined)?.();
				});
				return request;
			}
		});

		const { getConnectionStorageMode, getConnectionStore } = await import('./boot.js');
		const store = getConnectionStore();
		const [mode, entries] = await Promise.all([getConnectionStorageMode(), store.list()]);
		expect(mode).toBe('session-only');
		expect(entries).toEqual([]);
	});

	test('one shared failed probe keeps concurrent first operations session-only', async () => {
		const probe = deferred<never[]>();
		const persistent = fakeStorage({
			getAll: vi
				.fn()
				.mockImplementationOnce(() => probe.promise)
				.mockResolvedValueOnce([
					{
						id: 'persistent-only',
						label: 'Wrong backend',
						baseUrl: 'https://persistent.example',
						auth: { mode: 'none' }
					}
				])
		});
		const memory = fakeStorage();
		await installStorageDoubles(persistent, memory);
		vi.stubGlobal('indexedDB', {});

		const { getConnectionStorageMode, getConnectionStore } = await import('./boot.js');
		const mode = getConnectionStorageMode();
		const entries = getConnectionStore().list();
		probe.reject(new Error('private mode'));

		await expect(Promise.all([mode, entries])).resolves.toEqual(['session-only', []]);
		expect(persistent.getAll).toHaveBeenCalledTimes(1);
		expect(memory.getAll).toHaveBeenCalledTimes(2);
		await getConnectionStore().clearActive();
		expect(persistent.setMeta).not.toHaveBeenCalled();
		expect(memory.setMeta).toHaveBeenCalledWith('activeId', null);
	});

	test('the first storage access reuses the probe getAll() instead of querying twice (U2)', async () => {
		const persistent = fakeStorage({
			getAll: vi.fn(async () => [
				{
					id: 'seeded',
					label: 'Seeded connection',
					baseUrl: 'https://assistant.example',
					auth: { mode: 'none' } as const
				}
			])
		});
		const memory = fakeStorage();
		await installStorageDoubles(persistent, memory);
		vi.stubGlobal('indexedDB', {});

		const { getConnectionStorageMode } = await import('./boot.js');
		await expect(getConnectionStorageMode()).resolves.toBe('persistent');

		// pickStorage's availability probe already ran a getAll(); the first
		// real storage access must reuse that result rather than discarding
		// it and issuing a second read.
		expect(persistent.getAll).toHaveBeenCalledTimes(1);
	});

	test('a write error after persistent selection is surfaced without memory fallback', async () => {
		const writeError = new Error('transaction aborted');
		const persistent = fakeStorage({
			setMeta: vi.fn(async () => {
				throw writeError;
			})
		});
		const memory = fakeStorage();
		await installStorageDoubles(persistent, memory);
		vi.stubGlobal('indexedDB', {});

		const { getConnectionStorageMode, getConnectionStore } = await import('./boot.js');
		await expect(getConnectionStorageMode()).resolves.toBe('persistent');
		await expect(getConnectionStore().clearActive()).rejects.toBe(writeError);
		expect(memory.setMeta).not.toHaveBeenCalled();
		await expect(getConnectionStorageMode()).resolves.toBe('persistent');
	});
});
