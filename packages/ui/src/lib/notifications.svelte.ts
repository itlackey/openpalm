/**
 * Notification queue — singleton store for transient toasts.
 *
 * Use this for any non-blocking operator feedback: "Saving…", "Voice
 * addon started, let's chat!", network failures, etc. Voice errors are
 * routed through here too (the voice-state's `errorMessage` is mirrored
 * into a toast on change), so there's exactly one rendering surface.
 *
 * Usage:
 *
 *   import { notifications } from '$lib/notifications.svelte.js';
 *
 *   // One-shot info toast — auto-dismisses after 5s.
 *   notifications.push('info', 'Saving voice settings…');
 *
 *   // Sticky toast (no auto-dismiss). Returns an id so callers can
 *   // update or dismiss it as state evolves.
 *   const id = notifications.push('info', 'Starting voice addon…', {
 *     sticky: true,
 *   });
 *   // Later — replace by id so we don't pile up overlapping toasts:
 *   notifications.push('success', "Voice addon started, let's chat!", {
 *     replaceId: id,
 *   });
 *   // Or clear it explicitly:
 *   notifications.dismiss(id);
 */

export type ToastKind = 'info' | 'success' | 'error';

export type Toast = {
	id: string;
	kind: ToastKind;
	message: string;
	/** Number of ms remaining before auto-dismiss; null for sticky. */
	ttlMs: number | null;
};

const DEFAULT_TIMEOUTS: Record<ToastKind, number> = {
	info: 4_000,
	success: 5_000,
	error: 8_000,
};

class Notifications {
	toasts = $state<Toast[]>([]);
	private timers = new Map<string, ReturnType<typeof setTimeout>>();

	push(
		kind: ToastKind,
		message: string,
		opts: { sticky?: boolean; replaceId?: string; ttlMs?: number } = {},
	): string {
		const id = opts.replaceId ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const ttlMs = opts.sticky ? null : (opts.ttlMs ?? DEFAULT_TIMEOUTS[kind]);
		const toast: Toast = { id, kind, message, ttlMs };

		// Clear any pending timer for this id (replace-in-place semantic).
		const existingTimer = this.timers.get(id);
		if (existingTimer) {
			clearTimeout(existingTimer);
			this.timers.delete(id);
		}

		const existingIdx = this.toasts.findIndex((t) => t.id === id);
		if (existingIdx >= 0) {
			const next = [...this.toasts];
			next[existingIdx] = toast;
			this.toasts = next;
		} else {
			this.toasts = [...this.toasts, toast];
		}

		if (ttlMs !== null) {
			const timer = setTimeout(() => this.dismiss(id), ttlMs);
			this.timers.set(id, timer);
		}

		return id;
	}

	dismiss(id: string): void {
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}

	clear(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.toasts = [];
	}
}

export const notifications = new Notifications();
