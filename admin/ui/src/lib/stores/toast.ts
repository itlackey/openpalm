import { writable } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'info';

export type Toast = {
	id: number;
	message: string;
	type: ToastType;
};

let nextId = 0;

export const toasts = writable<Toast[]>([]);

export function showToast(message: string, type: ToastType = 'info', durationMs = 4000) {
	const id = nextId++;
	toasts.update((t) => [...t, { id, message, type }]);
	setTimeout(() => {
		toasts.update((t) => t.filter((toast) => toast.id !== id));
	}, durationMs);
}
