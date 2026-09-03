import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

// vi.mock factories are hoisted above their file's top-level statements, so
// any variable they reference must come from vi.hoisted() too.
const { DEFAULT_VERSIONS, fetchVersionsMock } = vi.hoisted(() => {
	// #679: `pins` holds ONLY the rows present in state/stack.env. Nothing
	// pinned by default — the normal state, where every image follows the tag
	// the release ships.
	const defaultVersions = { pins: {}, resolved: {}, running: null };
	return {
		DEFAULT_VERSIONS: defaultVersions,
		fetchVersionsMock: vi.fn().mockResolvedValue(defaultVersions)
	};
});

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
	clearInstallLock: vi.fn(),
	// #639/#679
	fetchVersions: fetchVersionsMock
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

// #639/#679 — a pinned image is one updates will not move, whether the
// operator typed the tag or recovery from a failed update wrote it. The notice
// states that fact without expanding a collapsed panel, and does NOT try to
// work out which cause produced it: guessing intent from a stored value is the
// failure this whole surface exists because of.
describe('RecoveryTab pin notice (#639/#679)', () => {
	test('shows no notice when nothing is pinned', async () => {
		fetchVersionsMock.mockResolvedValueOnce(DEFAULT_VERSIONS);
		await render(RecoveryTab);

		await expect.element(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
		await expect(page.getByText('Some images are pinned').query()).not.toBeInTheDocument();
	});

	test('names the pinned keys and says how to clear them', async () => {
		fetchVersionsMock.mockResolvedValueOnce({
			pins: { OP_ASSISTANT_VERSION: '0.13.0' },
			resolved: {},
			running: null
		});

		await render(RecoveryTab);

		await expect.element(page.getByText('Some images are pinned')).toBeVisible();
		await expect.element(page.getByText('OP_ASSISTANT_VERSION', { exact: false })).toBeVisible();
		// The unpin is a real, reachable action now — not "nothing to clear by
		// hand", which was true only because the pin cleared itself and, for
		// voice, never did.
		await expect.element(page.getByText('Advanced image tags', { exact: false })).toBeVisible();
	});
});
