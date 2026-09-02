import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

// vi.mock factories are hoisted above their file's top-level statements, so
// any variable they reference must come from vi.hoisted() too.
const { DEFAULT_VERSIONS, fetchVersionsMock } = vi.hoisted(() => {
	const defaultVersions = {
		configured: {
			OP_ASSISTANT_VERSION: '0.13.0',
			OP_GUARDIAN_VERSION: '0.13.0',
			OP_PORTAL_VERSION: '0.13.0',
			OP_VOICE_VERSION: 'latest'
		}
	};
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
	// #639
	fetchVersions: fetchVersionsMock,
	isRollbackPin: (value: string | undefined) => !!value?.startsWith('rollback-')
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

// #639 — the stack must surface a rollback-pinned image without expanding
// any collapsed panel, distinct from a deliberate operator pin. Read-only:
// there is no clear control, because the next successful update advances
// the pin off this tag on its own.
describe('RecoveryTab rollback pin notice (#639)', () => {
	test('shows no notice when nothing is pinned to a rollback generation', async () => {
		fetchVersionsMock.mockResolvedValueOnce(DEFAULT_VERSIONS);
		await render(RecoveryTab);

		await expect.element(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
		await expect(page.getByText('Stack pinned to a rollback image').query()).not.toBeInTheDocument();
	});

	test('shows no notice for a deliberate operator-pinned custom tag', async () => {
		fetchVersionsMock.mockResolvedValueOnce({
			configured: {
				OP_ASSISTANT_VERSION: 'my-custom-build',
				OP_GUARDIAN_VERSION: '0.13.0',
				OP_PORTAL_VERSION: '0.13.0',
				OP_VOICE_VERSION: 'latest'
			}
		});
		await render(RecoveryTab);

		await expect.element(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
		await expect(page.getByText('Stack pinned to a rollback image').query()).not.toBeInTheDocument();
	});

	test('shows the read-only notice naming the pinned key(s), with no clear control', async () => {
		fetchVersionsMock.mockResolvedValueOnce({
			configured: {
				OP_ASSISTANT_VERSION: 'rollback-generation-1788212586188-217761-1',
				OP_GUARDIAN_VERSION: '0.13.0',
				OP_PORTAL_VERSION: '0.13.0',
				OP_VOICE_VERSION: 'latest'
			}
		});

		await render(RecoveryTab);

		const notice = page.getByText('Stack pinned to a rollback image');
		await expect.element(notice).toBeVisible();
		await expect.element(page.getByText('OP_ASSISTANT_VERSION', { exact: false })).toBeVisible();
		await expect.element(page.getByText('nothing to clear by hand', { exact: false })).toBeVisible();

		await expect(page.getByRole('button', { name: 'Clear pin' }).query()).not.toBeInTheDocument();
	});
});
