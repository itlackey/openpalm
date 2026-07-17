import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const eventBus = vi.hoisted(() => ({
	emit: undefined as
		| undefined
		| ((payload: { type: string; properties?: Record<string, unknown> }) => void)
}));

vi.mock('$lib/endpoints-state.svelte.js', () => ({
	endpointsService: {
		active: { id: 'default', label: 'Local assistant', url: 'http://127.0.0.1:3800' },
		load: vi.fn().mockResolvedValue(undefined)
	}
}));
vi.mock('$lib/api.js', () => ({
	listSessions: vi.fn().mockResolvedValue([
		{ id: 'sess-1', title: 'First session', createdAt: 1, updatedAt: 3 },
		{ id: 'sess-2', title: 'Second session', createdAt: 1, updatedAt: 2 }
	]),
	getSessionMessages: vi.fn().mockResolvedValue([])
}));
vi.mock('$lib/chat/session-events.js', () => ({
	subscribeSessionEvents: vi.fn(
		(handlers: typeof eventBus & { onEvent?: typeof eventBus.emit }) => {
			eventBus.emit = handlers.onEvent;
			return vi.fn();
		}
	)
}));

import ActivityTab from './ActivityTab.svelte';

describe('ActivityTab accessibility', () => {
	test('exposes which recent-session selector is current', async () => {
		render(ActivityTab);
		const first = page.getByRole('button', { name: /First session/ });
		const second = page.getByRole('button', { name: /Second session/ });

		await expect.element(first, { timeout: 5000 }).toHaveAttribute('aria-current', 'true');
		await expect.element(second).not.toHaveAttribute('aria-current');
		await second.click();
		await expect.element(second).toHaveAttribute('aria-current', 'true');
		await expect.element(first).not.toHaveAttribute('aria-current');
	});

	test('keeps visible session text in shortcut accessible names', async () => {
		const { container } = render(ActivityTab);
		await vi.waitFor(() => expect(container.querySelectorAll('.session-row')).toHaveLength(2));
		eventBus.emit?.({
			type: 'permission.asked',
			properties: { sessionID: 'sess-1', permission: 'Run a command' }
		});

		await vi.waitFor(() => {
			const shortcuts = container.querySelectorAll<HTMLButtonElement>('.attention-session');
			expect(shortcuts.length).toBeGreaterThan(0);
			for (const shortcut of shortcuts) expect(shortcut).not.toHaveAttribute('aria-label');
		});
	});
});
