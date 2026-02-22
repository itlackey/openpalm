type ToastType = 'success' | 'error' | 'info';

interface Toast {
	id: number;
	message: string;
	type: ToastType;
}

let nextId = 0;
let toasts = $state<Toast[]>([]);

export function getToasts(): Toast[] {
	return toasts;
}

export function showToast(message: string, type: ToastType = 'info') {
	const id = nextId++;
	toasts.push({ id, message, type });
	setTimeout(() => {
		removeToast(id);
	}, 4000);
}

export function removeToast(id: number) {
	toasts = toasts.filter((t) => t.id !== id);
}
