import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$lib/api.js', () => ({
	fetchBackups: vi.fn().mockResolvedValue({
		ok: true,
		count: 2,
		totalBytes: 30,
		lastBackupAt: '2026-07-16T00:00:00.000Z',
		backups: [
			{ path: '/one', name: 'one', sizeBytes: 20, createdAt: '2026-07-16T00:00:00.000Z' },
			{ path: '/two', name: 'two', sizeBytes: 10, createdAt: '2026-07-15T00:00:00.000Z' }
		]
	}),
	pruneBackups: vi.fn(),
	fetchSecretStripNotice: vi.fn().mockResolvedValue({ ok: true, notice: null }),
	dismissSecretStripNotice: vi.fn(),
	fetchInstallLockStatus: vi.fn().mockResolvedValue({
		ok: true,
		present: false,
		stale: false,
		pid: null,
		timestamp: null,
		ageMs: null,
		path: '',
		staleAfterMs: 0
	}),
	clearInstallLock: vi.fn()
}));

import RecoveryTab from './RecoveryTab.svelte';

describe('RecoveryTab prune confirmation accessibility', () => {
	test('focuses the modal alertdialog and restores the trigger on Escape', async () => {
		const { container } = await render(RecoveryTab);
		const trigger = page.getByRole('button', { name: 'Prune…' });
		await expect.element(trigger, { timeout: 5000 }).toBeVisible();
		await trigger.click();

		const dialog = page.getByRole('alertdialog', { name: 'Confirm prune backups' });
		await expect.element(dialog).toHaveAttribute('aria-modal', 'true');
		await expect
			.element(page.getByRole('spinbutton', { name: 'Number of newest backups to keep' }))
			.toHaveFocus();
		expect(container.querySelector('.panel')).toHaveAttribute('inert');

		await userEvent.keyboard('{Escape}');
		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(trigger).toHaveFocus();
	});
});
