import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

describe('toast store', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should start with an empty toast list', async () => {
		const { toasts } = await import('./toast');
		expect(get(toasts)).toEqual([]);
	});

	it('showToast should add a toast with the correct message and type', async () => {
		const { toasts, showToast } = await import('./toast');
		showToast('Hello world', 'success');

		const current = get(toasts);
		expect(current).toHaveLength(1);
		expect(current[0].message).toBe('Hello world');
		expect(current[0].type).toBe('success');
		expect(typeof current[0].id).toBe('number');
	});

	it('showToast defaults to info type', async () => {
		const { toasts, showToast } = await import('./toast');
		showToast('Default type');

		const current = get(toasts);
		expect(current).toHaveLength(1);
		expect(current[0].type).toBe('info');
	});

	it('should add error toasts', async () => {
		const { toasts, showToast } = await import('./toast');
		showToast('Something failed', 'error');

		const current = get(toasts);
		expect(current).toHaveLength(1);
		expect(current[0].type).toBe('error');
		expect(current[0].message).toBe('Something failed');
	});

	it('should auto-dismiss after the default duration (4000ms)', async () => {
		const { toasts, showToast } = await import('./toast');
		showToast('Temporary message', 'info');

		expect(get(toasts)).toHaveLength(1);

		// Advance time just before the timeout
		vi.advanceTimersByTime(3999);
		expect(get(toasts)).toHaveLength(1);

		// Advance past the timeout
		vi.advanceTimersByTime(1);
		expect(get(toasts)).toHaveLength(0);
	});

	it('should auto-dismiss after a custom duration', async () => {
		const { toasts, showToast } = await import('./toast');
		showToast('Quick toast', 'success', 1000);

		expect(get(toasts)).toHaveLength(1);

		vi.advanceTimersByTime(999);
		expect(get(toasts)).toHaveLength(1);

		vi.advanceTimersByTime(1);
		expect(get(toasts)).toHaveLength(0);
	});

	it('should support multiple toasts stacking', async () => {
		const { toasts, showToast } = await import('./toast');
		showToast('First', 'info');
		showToast('Second', 'success');
		showToast('Third', 'error');

		const current = get(toasts);
		expect(current).toHaveLength(3);
		expect(current[0].message).toBe('First');
		expect(current[1].message).toBe('Second');
		expect(current[2].message).toBe('Third');
	});

	it('should dismiss toasts independently when they have different durations', async () => {
		const { toasts, showToast } = await import('./toast');
		showToast('Short', 'info', 1000);
		showToast('Long', 'info', 5000);

		expect(get(toasts)).toHaveLength(2);

		// Short toast expires
		vi.advanceTimersByTime(1000);
		const afterShort = get(toasts);
		expect(afterShort).toHaveLength(1);
		expect(afterShort[0].message).toBe('Long');

		// Long toast expires
		vi.advanceTimersByTime(4000);
		expect(get(toasts)).toHaveLength(0);
	});

	it('should allow manual dismissal by updating the store', async () => {
		const { toasts, showToast } = await import('./toast');
		showToast('To dismiss', 'info', 10000);

		const before = get(toasts);
		expect(before).toHaveLength(1);
		const toastId = before[0].id;

		// Manually dismiss by filtering the toast out of the store
		toasts.update((t) => t.filter((toast) => toast.id !== toastId));

		expect(get(toasts)).toHaveLength(0);
	});

	it('each toast gets a unique id', async () => {
		const { toasts, showToast } = await import('./toast');
		showToast('A', 'info');
		showToast('B', 'info');
		showToast('C', 'info');

		const current = get(toasts);
		const ids = current.map((t) => t.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(3);
	});
});
