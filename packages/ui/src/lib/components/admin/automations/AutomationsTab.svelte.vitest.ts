import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$lib/api.js', () => ({
	fetchTaskFile: vi.fn(),
	saveTaskFile: vi.fn(),
	deleteTaskFile: vi.fn().mockResolvedValue(undefined),
	runAutomation: vi.fn(),
	fetchAutomationLog: vi.fn()
}));

import AutomationsTab from './AutomationsTab.svelte';

const data = {
	automations: [
		{
			name: 'Daily summary',
			description: '',
			schedule: '0 8 * * *',
			timezone: 'UTC',
			enabled: true,
			valid: true,
			action: { type: 'assistant' as const, content: 'Summarize' },
			on_failure: 'log' as const,
			fileName: 'daily-summary.yml'
		}
	]
};

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
});

describe('AutomationsTab invalid task recovery', () => {
	test('keeps raw invalid tasks editable and disables execution', async () => {
		await render(AutomationsTab, {
			props: {
				data: {
					automations: [{
						name: 'broken',
						description: 'AKM could not parse this task. Edit or delete the raw file.',
						schedule: '',
						timezone: 'UTC',
						enabled: false,
						valid: false,
						action: { type: 'shell' as const },
						on_failure: 'log' as const,
						fileName: 'broken.yml'
					}]
				},
				loading: false,
				error: '',
				onRefresh: vi.fn()
			}
		});

		await expect.element(page.getByText('Needs repair')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Run now' })).toBeDisabled();
		await expect.element(page.getByRole('button', { name: 'Edit' })).toBeEnabled();
	});
});
