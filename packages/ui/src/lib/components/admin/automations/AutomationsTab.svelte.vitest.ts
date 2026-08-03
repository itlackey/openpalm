import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$lib/api.js', () => ({
	fetchTaskFile: vi.fn().mockResolvedValue({
		fileName: 'daily-summary.yml',
		content: 'opaque: text\n',
		revision: 'sha256:edit-revision'
	}),
	saveTaskFile: vi.fn().mockResolvedValue({
		ok: true,
		fileName: 'daily-summary.yml',
		revision: 'sha256:saved-revision'
	}),
	deleteTaskFile: vi.fn().mockResolvedValue(undefined),
	runAutomation: vi.fn().mockResolvedValue({ ok: true, fileName: 'broken.yml', status: 'completed', error: null }),
	fetchAutomationLog: vi.fn().mockResolvedValue({ fileName: 'broken.yml', lines: [] })
}));

import {
	deleteTaskFile,
	fetchAutomationLog,
	fetchTaskFile,
	runAutomation,
	saveTaskFile
} from '$lib/api.js';
import AutomationsTab from './AutomationsTab.svelte';

const data = {
	automations: [
		{
			taskId: 'daily-summary',
			fileName: 'daily-summary.yml',
			size: 123,
			revision: 'sha256:list-revision',
			schedulable: true
		}
	]
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe('AutomationsTab delete confirmation accessibility', () => {
	test('focuses and traps the modal alertdialog, then restores focus on Escape', async () => {
		const { container } = await render(AutomationsTab, {
			props: { data, loading: false, error: '', onRefresh: vi.fn() }
		});
		const trigger = page.getByRole('button', { name: 'Delete daily-summary.yml' });
		await trigger.click();

		const dialog = page.getByRole('alertdialog', { name: 'Confirm delete task' });
		await expect.element(dialog).toHaveAttribute('aria-modal', 'true');
		await expect
			.element(page.getByRole('button', { name: 'Delete task', exact: true }))
			.toHaveFocus();
		expect(container.querySelector('.panel')).toHaveAttribute('inert');

		await userEvent.keyboard('{Escape}');
		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(trigger).toHaveFocus();
	});

	test('forwards the listed revision as the delete precondition', async () => {
		await render(AutomationsTab, {
			props: { data, loading: false, error: '', onRefresh: vi.fn() }
		});
		await page.getByRole('button', { name: 'Delete daily-summary.yml' }).click();
		await page.getByRole('button', { name: 'Delete task', exact: true }).click();

		expect(deleteTaskFile).toHaveBeenCalledWith('daily-summary.yml', 'sha256:list-revision');
	});
});

describe('AutomationsTab task authority', () => {
	test('shows only file metadata and delegates execution to AKM', async () => {
		await render(AutomationsTab, {
			props: {
						data: {
						automations: [{
						taskId: 'broken',
						fileName: 'broken.yml',
						size: 17,
						revision: 'sha256:broken-revision',
						schedulable: true
					}]
				},
				loading: false,
				error: '',
				onRefresh: vi.fn()
			}
		});

		await expect.element(page.getByText('AKM validates during reconciliation and run.')).toBeInTheDocument();
		await expect.element(page.getByText('17 bytes')).toBeInTheDocument();
		await expect.element(page.getByText('Enabled')).not.toBeInTheDocument();
		await expect.element(page.getByText('Needs repair')).not.toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Run now' })).toBeEnabled();
		await expect.element(page.getByRole('button', { name: 'Edit' })).toBeEnabled();

		await page.getByRole('button', { name: 'Run now' }).click();
		expect(runAutomation).toHaveBeenCalledWith('broken.yml');

		await page.getByRole('button', { name: 'View latest log' }).click();
		expect(fetchAutomationLog).toHaveBeenCalledWith('broken.yml', 200);
	});

	test('keeps unschedulable files editable and deletable but disables run and logs', async () => {
		await render(AutomationsTab, {
			props: {
				data: {
					automations: [{
						taskId: 'foo ',
						fileName: 'foo .yml',
						size: 4,
						revision: 'sha256:repair-revision',
						schedulable: false
					}]
				},
				loading: false,
				error: '',
				onRefresh: vi.fn()
			}
		});

		await expect.element(page.getByText('Filename is not schedulable. Edit or delete this file.')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Run now' })).toBeDisabled();
		await expect.element(page.getByRole('button', { name: 'View latest log' })).toBeDisabled();
		await expect.element(page.getByRole('button', { name: 'Edit' })).toBeEnabled();
		await expect.element(page.getByRole('button', { name: 'Delete foo .yml' })).toBeEnabled();
	});

	test('forwards the fetched revision as the save precondition', async () => {
		await render(AutomationsTab, {
			props: { data, loading: false, error: '', onRefresh: vi.fn() }
		});
		await page.getByRole('button', { name: 'Edit' }).click();
		await page.getByRole('button', { name: 'Save' }).click();

		expect(fetchTaskFile).toHaveBeenCalledWith('daily-summary.yml');
		expect(saveTaskFile).toHaveBeenCalledWith(
			'daily-summary.yml',
			'opaque: text\n',
			'sha256:edit-revision'
		);
	});

});
