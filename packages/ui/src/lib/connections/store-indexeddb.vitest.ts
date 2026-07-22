import { afterEach, describe, expect, test, vi } from 'vitest';
import { type Connection, createIndexedDbStorage } from './store.js';

type FakeRequest = {
	result?: unknown;
	error?: Error | null;
	onsuccess?: () => void;
	onerror?: () => void;
};

type FakeTransaction = {
	error: Error | null;
	oncomplete: (() => void) | null;
	onerror: (() => void) | null;
	onabort: (() => void) | null;
	abort(): void;
	storeNames: string | string[];
	operations: Array<{
		store: string;
		type: 'get' | 'put' | 'delete';
		key?: string;
		value?: unknown;
	}>;
	objectStore(name: string): {
		get(key: string): FakeRequest;
		put(value: unknown, key?: string): FakeRequest;
		delete(key: string): FakeRequest;
	};
	request: FakeRequest;
	getRequests: FakeRequest[];
};

function installIndexedDb(): FakeTransaction[] {
	const transactions: FakeTransaction[] = [];
	const database = {
		onversionchange: null as (() => void) | null,
		close: vi.fn(),
		transaction(storeNames: string | string[]) {
			const request: FakeRequest = { error: null };
			const transaction: FakeTransaction = {
				error: null,
				oncomplete: null,
				onerror: null,
				onabort: null,
				abort: vi.fn(),
				storeNames,
				operations: [],
				request,
				getRequests: [],
				objectStore: (name) => ({
					get: (key) => {
						const getRequest =
							transaction.getRequests.length === 0 ? request : { error: null };
						transaction.getRequests.push(getRequest);
						transaction.operations.push({ store: name, type: 'get', key });
						return getRequest;
					},
					put: (value, key) => {
						transaction.operations.push({
							store: name,
							type: 'put',
							value,
							...(key ? { key } : {})
						});
						return request;
					},
					delete: (key) => {
						transaction.operations.push({ store: name, type: 'delete', key });
						return request;
					}
				})
			};
			transactions.push(transaction);
			return transaction;
		}
	};
	vi.stubGlobal('indexedDB', {
		open() {
			const request: FakeRequest = { result: database, error: null };
			queueMicrotask(() => request.onsuccess?.());
			return request;
		}
	});
	return transactions;
}

async function waitForTransaction(transactions: FakeTransaction[]): Promise<FakeTransaction> {
	while (transactions.length === 0) await Promise.resolve();
	return transactions[0];
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('IndexedDB write commit semantics', () => {
	test('updates from the durable record and returns it only after the transaction commits', async () => {
		const transactions = installIndexedDb();
		const storage = createIndexedDbStorage();
		const pending = storage.updateConnection('connection-1', {
			auth: { mode: 'basic', username: 'new', secretRef: 'secret-new' }
		});
		const transaction = await waitForTransaction(transactions);
		const previous = {
			id: 'connection-1',
			label: 'Connection',
			baseUrl: 'https://assistant.example',
			auth: { mode: 'basic', username: 'current', secretRef: 'secret-current' }
		} satisfies Connection;

		expect(transaction.storeNames).toBe('connections');
		expect(transaction.operations).toEqual([
			{ store: 'connections', type: 'get', key: 'connection-1' }
		]);
		transaction.request.result = previous;
		transaction.request.onsuccess?.();
		expect(transaction.operations).toEqual([
			{ store: 'connections', type: 'get', key: 'connection-1' },
			{
				store: 'connections',
				type: 'put',
				value: {
					...previous,
					auth: { mode: 'basic', username: 'new', secretRef: 'secret-new' }
				}
			}
		]);

		const beforeComplete = await Promise.race([
			pending.then(() => 'resolved'),
			new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
		]);
		expect(beforeComplete).toBe('pending');
		transaction.oncomplete?.();
		await expect(pending).resolves.toEqual({
			previous,
			updated: {
				...previous,
				auth: { mode: 'basic', username: 'new', secretRef: 'secret-new' }
			}
		});
	});

	test('aborts an atomic update when the durable record is locked', async () => {
		const transactions = installIndexedDb();
		const pending = createIndexedDbStorage().updateConnection('connection-1', { label: 'Changed' });
		const transaction = await waitForTransaction(transactions);
		transaction.request.result = {
			id: 'connection-1',
			label: 'Locked',
			baseUrl: 'https://assistant.example',
			auth: { mode: 'none' },
			locked: true
		} satisfies Connection;
		transaction.request.onsuccess?.();

		expect(transaction.abort).toHaveBeenCalledOnce();
		expect(transaction.operations).toEqual([
			{ store: 'connections', type: 'get', key: 'connection-1' }
		]);
		transaction.onabort?.();
		await expect(pending).rejects.toThrow(/locked/);
	});

	test('aborts an atomic removal when the durable record is locked', async () => {
		const transactions = installIndexedDb();
		const pending = createIndexedDbStorage().removeConnectionState('connection-1');
		const transaction = await waitForTransaction(transactions);
		transaction.request.result = {
			id: 'connection-1',
			label: 'Locked',
			baseUrl: 'https://assistant.example',
			auth: { mode: 'none' },
			locked: true
		} satisfies Connection;
		transaction.request.onsuccess?.();

		expect(transaction.abort).toHaveBeenCalledOnce();
		expect(transaction.operations).toEqual([
			{ store: 'connections', type: 'get', key: 'connection-1' }
		]);
		transaction.onabort?.();
		await expect(pending).rejects.toThrow(/locked/);
	});

	test.each([
		[
			'connection put',
			(storage: ReturnType<typeof createIndexedDbStorage>) =>
				storage.put({
					id: 'connection-1',
					label: 'Connection',
					baseUrl: 'https://assistant.example',
					auth: { mode: 'none' }
				} satisfies Connection)
		],
		[
			'meta put',
			(storage: ReturnType<typeof createIndexedDbStorage>) =>
				storage.setMeta('activeId', 'connection-1')
		],
		[
			'meta delete',
			(storage: ReturnType<typeof createIndexedDbStorage>) => storage.setMeta('activeId', null)
		],
		[
			'key put',
			(storage: ReturnType<typeof createIndexedDbStorage>) => storage.setCryptoKey({} as CryptoKey)
		]
	])('%s resolves only after transaction completion', async (_name, write) => {
		const transactions = installIndexedDb();
		const pending = write(createIndexedDbStorage());
		const transaction = await waitForTransaction(transactions);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});

		transaction.request.onsuccess?.();
		const beforeComplete = await Promise.race([
			pending.then(() => 'resolved'),
			new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
		]);
		expect(beforeComplete).toBe('pending');
		expect(settled).toBe(false);

		transaction.oncomplete?.();
		await expect(pending).resolves.toBeUndefined();
	});

	test('rejects an aborted write transaction even if its request succeeded', async () => {
		const transactions = installIndexedDb();
		const pending = createIndexedDbStorage().setMeta('activeId', 'connection-1');
		const transaction = await waitForTransaction(transactions);
		const abortError = new Error('transaction aborted');
		transaction.request.onsuccess?.();
		transaction.error = abortError;
		transaction.onabort?.();

		const outcome = await Promise.race([
			pending.then(
				() => 'resolved',
				(error: unknown) => error
			),
			new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20))
		]);
		expect(outcome).toBe(abortError);
	});

	test('rejects a failed write transaction', async () => {
		const transactions = installIndexedDb();
		const pending = createIndexedDbStorage().removeConnectionState('connection-1');
		const transaction = await waitForTransaction(transactions);
		const transactionError = new Error('transaction failed');
		transaction.error = transactionError;
		transaction.onerror?.();

		await expect(pending).rejects.toBe(transactionError);
	});

	test('removes the connection, active id, and cursor in one transaction', async () => {
		const transactions = installIndexedDb();
		const pending = createIndexedDbStorage().removeConnectionState('connection-1');
		const transaction = await waitForTransaction(transactions);

		expect(transaction.storeNames).toEqual(['connections', 'meta']);
		expect(transaction.operations).toEqual([
			{ store: 'connections', type: 'get', key: 'connection-1' }
		]);
		const removed = {
			id: 'connection-1',
			label: 'Connection',
			baseUrl: 'https://assistant.example',
			auth: { mode: 'basic', username: 'current', secretRef: 'secret-current' }
		} satisfies Connection;
		transaction.request.result = removed;
		transaction.request.onsuccess?.();
		expect(transaction.operations).toEqual([
			{ store: 'connections', type: 'get', key: 'connection-1' },
			{ store: 'connections', type: 'delete', key: 'connection-1' },
			{ store: 'meta', type: 'delete', key: 'lastSession:connection-1' },
			{ store: 'meta', type: 'get', key: 'activeId' }
		]);
		transaction.getRequests[1].result = 'connection-1';
		transaction.getRequests[1].onsuccess?.();
		expect(transaction.operations.at(-1)).toEqual({
			store: 'meta',
			type: 'delete',
			key: 'activeId'
		});
		const beforeComplete = await Promise.race([
			pending.then(() => 'resolved'),
			new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
		]);
		expect(beforeComplete).toBe('pending');
		transaction.oncomplete?.();
		await expect(pending).resolves.toEqual(removed);
		expect(transactions).toHaveLength(1);
	});

	test('rejects atomic connection-state removal as one unit when its transaction aborts', async () => {
		const transactions = installIndexedDb();
		const pending = createIndexedDbStorage().removeConnectionState('connection-1');
		const transaction = await waitForTransaction(transactions);
		const abortError = new Error('atomic removal aborted');
		transaction.request.result = {
			id: 'connection-1',
			label: 'Connection',
			baseUrl: 'https://assistant.example',
			auth: { mode: 'none' }
		} satisfies Connection;
		transaction.request.onsuccess?.();
		transaction.error = abortError;
		transaction.onabort?.();

		await expect(pending).rejects.toBe(abortError);
		expect(transactions).toHaveLength(1);
	});

	test('setActive validates and writes in one connections+meta transaction', async () => {
		const transactions = installIndexedDb();
		const pending = createIndexedDbStorage().setActive('connection-1');
		const transaction = await waitForTransaction(transactions);

		expect(transaction.storeNames).toEqual(['connections', 'meta']);
		expect(transaction.operations).toEqual([
			{ store: 'connections', type: 'get', key: 'connection-1' }
		]);
		transaction.request.result = {
			id: 'connection-1',
			label: 'Connection',
			baseUrl: 'https://assistant.example',
			auth: { mode: 'none' }
		};
		transaction.request.onsuccess?.();

		expect(transaction.operations).toEqual([
			{ store: 'connections', type: 'get', key: 'connection-1' },
			{ store: 'meta', type: 'put', key: 'activeId', value: 'connection-1' }
		]);
		transaction.oncomplete?.();
		await expect(pending).resolves.toBe('updated');
	});

	test('compareAndSetActive validates target and compares metadata in one transaction', async () => {
		const transactions = installIndexedDb();
		const pending = createIndexedDbStorage().compareAndSetActive('alpha', 'beta');
		const transaction = await waitForTransaction(transactions);

		expect(transaction.storeNames).toEqual(['connections', 'meta']);
		expect(transaction.operations).toEqual([
			{ store: 'connections', type: 'get', key: 'beta' },
			{ store: 'meta', type: 'get', key: 'activeId' }
		]);
		transaction.getRequests[0].result = {
			id: 'beta',
			label: 'Beta',
			baseUrl: 'https://beta.example',
			auth: { mode: 'none' }
		};
		transaction.getRequests[0].onsuccess?.();
		transaction.getRequests[1].result = 'alpha';
		transaction.getRequests[1].onsuccess?.();
		expect(transaction.operations.at(-1)).toEqual({
			store: 'meta',
			type: 'put',
			key: 'activeId',
			value: 'beta'
		});
		transaction.oncomplete?.();

		await expect(pending).resolves.toBe('updated');
	});

	test('compareAndSetActive does not write when its target is missing', async () => {
		const transactions = installIndexedDb();
		const pending = createIndexedDbStorage().compareAndSetActive('alpha', 'removed');
		const transaction = await waitForTransaction(transactions);
		transaction.getRequests[0].result = undefined;
		transaction.getRequests[0].onsuccess?.();
		transaction.getRequests[1].result = 'alpha';
		transaction.getRequests[1].onsuccess?.();
		transaction.oncomplete?.();

		await expect(pending).resolves.toBe('target-missing');
		expect(transaction.operations.some((operation) => operation.type === 'put')).toBe(false);
	});
});
