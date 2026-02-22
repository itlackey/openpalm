import { browser } from '$app/environment';

const STORAGE_KEY = 'op_admin';

let adminToken = $state(browser ? localStorage.getItem(STORAGE_KEY) ?? '' : '');

export function getAdminToken(): string {
	return adminToken;
}

export function setAdminToken(token: string) {
	adminToken = token;
	if (browser) {
		localStorage.setItem(STORAGE_KEY, token);
	}
}
