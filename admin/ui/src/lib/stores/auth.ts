import { writable } from 'svelte/store';

const STORAGE_KEY = 'op_admin';

function getStoredToken(): string {
	if (typeof window === 'undefined') return '';
	return localStorage.getItem(STORAGE_KEY) ?? '';
}

export const authToken = writable<string>(getStoredToken());

export function setToken(token: string) {
	if (typeof window !== 'undefined') {
		localStorage.setItem(STORAGE_KEY, token);
	}
	authToken.set(token);
}

export function clearToken() {
	if (typeof window !== 'undefined') {
		localStorage.removeItem(STORAGE_KEY);
	}
	authToken.set('');
}
