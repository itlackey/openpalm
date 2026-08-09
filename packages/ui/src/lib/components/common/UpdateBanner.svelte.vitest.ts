// UpdateBanner.svelte — per-version dismissal (review E6). `dismissed` used to
// be a one-way boolean, so dismissing version X also suppressed a LATER
// version Y for the rest of the app session (localStorage has no key for Y).
// Visibility is now re-derived from the CURRENT availableVersion's dismissKey
// on every pushed state.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import UpdateBanner from './UpdateBanner.svelte';

function updaterState(overrides: Partial<UpdaterState> = {}): UpdaterState {
	return {
		status: 'available',
		currentVersion: '1.0.0',
		availableVersion: '2.0.0',
		percent: null,
		error: null,
		channel: 'stable',
		supported: true,
		releasesUrl: 'https://github.com/itlackey/openpalm/releases',
		...overrides
	};
}

describe('UpdateBanner', () => {
	// Captured from the component's onState subscription so tests can push
	// later main-process state the way the desktop shell does.
	let pushState: (next: UpdaterState) => void;

	beforeEach(() => {
		localStorage.clear();
		pushState = () => {};
		window.openpalm = {
			updater: {
				state: vi.fn().mockResolvedValue(updaterState()),
				check: vi.fn().mockResolvedValue(updaterState()),
				download: vi.fn().mockResolvedValue(updaterState()),
				quitAndInstall: vi.fn().mockResolvedValue(true),
				onState: vi.fn((callback: (next: UpdaterState) => void) => {
					pushState = callback;
					return () => {};
				})
			}
		};
	});

	test('dismissing version X does not suppress a later version Y (E6)', async () => {
		await render(UpdateBanner);

		await expect.element(page.getByText('v2.0.0')).toBeVisible();

		await page.getByRole('button', { name: 'Dismiss' }).click();
		await expect.element(page.getByText('v2.0.0')).not.toBeInTheDocument();

		// A later release arrives — the old dismissal must not swallow it.
		pushState(updaterState({ availableVersion: '2.1.0' }));
		await expect.element(page.getByText('v2.1.0')).toBeVisible();
	});

	test('a version dismissed in an earlier session stays dismissed', async () => {
		// Legacy '1' value, written before dismissals recorded their phase.
		localStorage.setItem('openpalm.updateBanner.dismissed.2.0.0', '1');
		await render(UpdateBanner);

		await vi.waitFor(() => {
			expect(window.openpalm?.updater?.onState).toHaveBeenCalledOnce();
		});
		await expect.element(page.getByText('v2.0.0')).not.toBeInTheDocument();

		// ...but a NEWER version still surfaces.
		pushState(updaterState({ availableVersion: '2.1.0' }));
		await expect.element(page.getByText('v2.1.0')).toBeVisible();
	});

	// A dismissal suppresses only the phase it was made in. Dismissing the
	// "available" prompt must not also swallow the "ready to install" prompt,
	// or the in-app "Restart and update" action becomes unreachable for that
	// version.
	test('dismissing the available prompt still surfaces the downloaded one', async () => {
		await render(UpdateBanner);

		await expect.element(page.getByText('v2.0.0')).toBeVisible();
		await page.getByRole('button', { name: 'Dismiss' }).click();
		await expect.element(page.getByText('v2.0.0')).not.toBeInTheDocument();

		pushState(updaterState({ status: 'downloaded' }));
		await expect.element(page.getByRole('button', { name: 'Restart and update' })).toBeVisible();
	});

	test('dismissing the downloaded prompt keeps that version hidden', async () => {
		await render(UpdateBanner);
		await expect.element(page.getByText('v2.0.0')).toBeVisible();

		pushState(updaterState({ status: 'downloaded' }));
		await page.getByRole('button', { name: 'Dismiss' }).click();
		await expect.element(page.getByRole('button', { name: 'Restart and update' })).not.toBeInTheDocument();

		// Re-pushing the same downloaded state must not resurrect it.
		pushState(updaterState({ status: 'downloaded' }));
		await expect.element(page.getByRole('button', { name: 'Restart and update' })).not.toBeInTheDocument();
	});
});
