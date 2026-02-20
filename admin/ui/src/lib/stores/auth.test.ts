import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

describe('auth store', () => {
	beforeEach(() => {
		// Clear localStorage before each test
		localStorage.clear();
		// Reset modules so each test gets a fresh store initialized from localStorage
		vi.resetModules();
	});

	it('should start with an empty token when localStorage is empty', async () => {
		const { authToken } = await import('./auth');
		expect(get(authToken)).toBe('');
	});

	it('should initialize from localStorage if a token exists', async () => {
		localStorage.setItem('op_admin', 'stored-token-123');
		const { authToken } = await import('./auth');
		expect(get(authToken)).toBe('stored-token-123');
	});

	it('setToken should update the store and persist to localStorage', async () => {
		const { authToken, setToken } = await import('./auth');
		setToken('my-secret-token');
		expect(get(authToken)).toBe('my-secret-token');
		expect(localStorage.getItem('op_admin')).toBe('my-secret-token');
	});

	it('setToken roundtrip: set then get returns the same value', async () => {
		const { authToken, setToken } = await import('./auth');
		setToken('roundtrip-value');
		expect(get(authToken)).toBe('roundtrip-value');

		// Simulate a fresh module load picking up from localStorage
		vi.resetModules();
		const { authToken: freshToken } = await import('./auth');
		expect(get(freshToken)).toBe('roundtrip-value');
	});

	it('clearToken should remove the token from store and localStorage', async () => {
		const { authToken, setToken, clearToken } = await import('./auth');
		setToken('to-be-cleared');
		expect(get(authToken)).toBe('to-be-cleared');
		expect(localStorage.getItem('op_admin')).toBe('to-be-cleared');

		clearToken();
		expect(get(authToken)).toBe('');
		expect(localStorage.getItem('op_admin')).toBeNull();
	});

	it('hasToken: store value is truthy when token is set, falsy when empty', async () => {
		const { authToken, setToken, clearToken } = await import('./auth');

		// Initially no token
		expect(!!get(authToken)).toBe(false);

		// Set a token
		setToken('some-token');
		expect(!!get(authToken)).toBe(true);

		// Clear it
		clearToken();
		expect(!!get(authToken)).toBe(false);
	});

	it('setToken can overwrite a previous token', async () => {
		const { authToken, setToken } = await import('./auth');
		setToken('first');
		expect(get(authToken)).toBe('first');
		setToken('second');
		expect(get(authToken)).toBe('second');
		expect(localStorage.getItem('op_admin')).toBe('second');
	});
});
