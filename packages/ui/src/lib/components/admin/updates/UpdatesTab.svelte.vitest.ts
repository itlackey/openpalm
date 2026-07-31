import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$lib/api.js', () => ({
	applyChanges: vi.fn(),
	applyServiceUpdate: vi.fn(),
	fetchVersions: vi.fn(),
	patchVersions: vi.fn()
}));

import { applyChanges, applyServiceUpdate, fetchVersions, patchVersions } from '$lib/api.js';
import type { ServiceEntry } from '$lib/types.js';
import UpdatesTab from './UpdatesTab.svelte';

const versionsResponse = {
	configured: {
		OP_ASSISTANT_VERSION: '99.0.0',
		OP_GUARDIAN_VERSION: 'latest',
		OP_PORTAL_VERSION: 'latest',
		OP_VOICE_VERSION: '0.13.0'
	}
};

function service(service: string, state: string, image: string, health: string): ServiceEntry {
	return {
		id: service,
		service,
		state,
		docker: {
			ID: service,
			Name: service,
			Names: service,
			Service: service,
			Image: image,
			State: state,
			Status: state,
			Health: health,
			Ports: '',
			Project: 'openpalm',
			RunningFor: '',
			CreatedAt: ''
		}
	};
}

const containers = [
	service('assistant', 'running', 'openpalm/assistant:99.0.0', 'healthy'),
	service('discord', 'stopped', 'openpalm/portal:latest', ''),
	service('slack', 'running', 'openpalm/portal:0.13.0-beta.5', 'healthy')
];
const onRefresh = vi.fn().mockResolvedValue(undefined);

function renderUpdates(): void {
	render(UpdatesTab, {
		props: { containers, dockerAvailable: true, onRefresh }
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(fetchVersions).mockResolvedValue(versionsResponse);
	vi.mocked(applyServiceUpdate).mockResolvedValue(undefined);
	vi.mocked(applyChanges).mockResolvedValue(undefined);
	vi.mocked(patchVersions).mockResolvedValue(undefined);
	onRefresh.mockResolvedValue(undefined);
	window.openpalm = {
		launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
		setLaunchOnLogin: vi.fn()
	};
});

describe('UpdatesTab', () => {
	test('shows actual Compose services without collapsing portal adapters', async () => {
		renderUpdates();

		await expect.element(page.getByText('assistant', { exact: true })).toBeVisible();
		await expect.element(page.getByText('discord', { exact: true })).toBeVisible();
		await expect.element(page.getByText('slack', { exact: true })).toBeVisible();
		await expect.element(page.getByText('openpalm/portal:latest')).toBeVisible();
	});

	test('does not semver-gate running services and does not start stopped services', async () => {
		renderUpdates();

		const assistantUpdate = page.getByRole('button', { name: 'Update assistant' });
		const stoppedAdapterUpdate = page.getByRole('button', { name: 'Update discord' });
		await expect.element(assistantUpdate).toBeEnabled();
		await expect.element(stoppedAdapterUpdate).toBeDisabled();
		await assistantUpdate.click();

		await vi.waitFor(() => {
			expect(applyServiceUpdate).toHaveBeenCalledWith('assistant');
		});
	});

	test('dispatches one accurately named stack update with no target payload', async () => {
		renderUpdates();

		await page.getByRole('button', { name: 'Update OpenPalm stack' }).click();

		await vi.waitFor(() => {
			expect(applyChanges).toHaveBeenCalledWith();
		});
	});

	test('edits the four configured version keys separately from container updates', async () => {
		renderUpdates();

		await page.getByText('Advanced image tags').click();
		const assistantTag = page.getByRole('textbox', { name: 'OP_ASSISTANT_VERSION' });
		await assistantTag.fill('100.0.0');
		await page.getByRole('button', { name: 'Save advanced settings' }).click();

		await vi.waitFor(() => {
			expect(patchVersions).toHaveBeenCalledWith({
				OP_ASSISTANT_VERSION: '100.0.0',
				OP_GUARDIAN_VERSION: 'latest',
				OP_PORTAL_VERSION: 'latest',
				OP_VOICE_VERSION: '0.13.0'
			});
		});
		expect(applyServiceUpdate).not.toHaveBeenCalled();
	});

	test('keeps Electron launch-on-login settings', async () => {
		const setLaunchOnLogin = vi.fn().mockResolvedValue({ supported: true, enabled: true });
		window.openpalm = {
			launchOnLoginStatus: vi.fn().mockResolvedValue({ supported: true, enabled: false }),
			setLaunchOnLogin
		};
		renderUpdates();

		const toggle = page.getByRole('checkbox', {
			name: /start openpalm automatically when you sign in/i
		});
		await toggle.click();

		expect(setLaunchOnLogin).toHaveBeenCalledWith(true);
	});
});
