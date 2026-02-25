import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SetupWizard from './SetupWizard.svelte';

// --- Hoisted mock state -------------------------------------------------------
// vi.mock factories are hoisted to the top of the file before any variable
// declarations. We must use vi.hoisted() for any values referenced inside them.

const { wizardState, mockSetWizardStep, mockApi } = vi.hoisted(() => {
	const wizardState = { step: 0 };
	const mockSetWizardStep = vi.fn((n: number) => {
		wizardState.step = n;
	});
	const mockApi = vi.fn().mockResolvedValue({ ok: true, data: null });
	return { wizardState, mockSetWizardStep, mockApi };
});

// --- Module mocks -----------------------------------------------------------

// Mock $app/environment so WelcomeStep can read `version` and
// auth.svelte.ts can check the `browser` flag without crashing.
vi.mock('$app/environment', () => ({
	version: 'test',
	browser: true,
	dev: true,
	building: false
}));

// Stub all API calls so tests never hit the network.
vi.mock('$lib/api', () => ({
	api: mockApi
}));

// Control which wizard step is active using a plain state object.
// Pre-setting wizardState.step before render() controls the initial step
// since $derived reads getWizardStep() on first render.
vi.mock('$lib/stores/setup.svelte', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/stores/setup.svelte')>();
	return {
		...original,
		getWizardStep: () => wizardState.step,
		setWizardStep: mockSetWizardStep,
		getSetupState: () => null
	};
});

// ---------------------------------------------------------------------------

describe('SetupWizard — rendered component tests', () => {
	beforeEach(() => {
		wizardState.step = 0;
		mockApi.mockClear();
		mockSetWizardStep.mockClear();
	});

	// -------------------------------------------------------------------------
	// Test 1: renders the Welcome step on first render
	// -------------------------------------------------------------------------
	it('renders the Welcome step initially', async () => {
		render(SetupWizard, { onclose: vi.fn() });

		// The wizard <h2> title for step 0 is "Welcome" (STEP_TITLES[0])
		// SetupWizard.svelte:256
		await expect.element(page.getByRole('heading', { level: 2, name: 'Welcome' })).toBeVisible();

		// WelcomeStep renders a paragraph starting with "Welcome to OpenPalm"
		// WelcomeStep.svelte:5-7
		await expect.element(page.getByText(/Welcome to OpenPalm/)).toBeVisible();

		// The "Next" button should be present on step 0 (not the last content step)
		// SetupWizard.svelte:294
		await expect.element(page.getByRole('button', { name: 'Next' })).toBeVisible();

		// The "Back" button should NOT be present on step 0
		// SetupWizard.svelte:286-288
		await expect.element(page.getByRole('button', { name: 'Back' })).not.toBeInTheDocument();
	});

	// -------------------------------------------------------------------------
	// Test 2: clicking Next on Welcome calls setWizardStep(1)
	// -------------------------------------------------------------------------
	it('advances to the Profile step when Next is clicked on Welcome', async () => {
		render(SetupWizard, { onclose: vi.fn() });

		const nextButton = page.getByRole('button', { name: 'Next' });
		await nextButton.click();

		// wizardNext() for step 'welcome' has no API call — it goes straight to
		// setWizardStep(currentStep + 1). Verify the call was made with step 1.
		// SetupWizard.svelte:179
		expect(mockSetWizardStep).toHaveBeenCalledWith(1);
		expect(mockSetWizardStep).toHaveBeenCalledTimes(1);
	});

	// -------------------------------------------------------------------------
	// Test 3: shows an error when the password is shorter than 8 characters
	// -------------------------------------------------------------------------
	it('shows a short-password error on the Profile step', async () => {
		wizardState.step = 1; // start at Profile step

		render(SetupWizard, { onclose: vi.fn() });

		// Verify we are on the Profile step
		// SetupWizard.svelte:256
		await expect.element(page.getByRole('heading', { level: 2, name: 'Profile' })).toBeVisible();

		// Fill the password field with a 7-character value
		// ProfileStep.svelte:36-41 — input id="wiz-profile-password"
		// Use getByLabelText since password inputs may not be exposed as 'textbox' role
		const passwordInput = page.getByLabelText(/Admin password/i);
		await passwordInput.fill('short1');

		// Leave the confirm-password field empty (default)
		await page.getByRole('button', { name: 'Next' }).click();

		// The error banner rendered in SetupWizard.svelte:280-282:
		//   <div class="wiz-error visible">{stepError}</div>
		// SetupWizard.svelte:76: stepError = 'Password must be at least 8 characters.'
		// Note: ProfileStep also renders the same error text inside its own .wiz-error div,
		// so two elements match. Use .first() to avoid strict-mode violation.
		await expect.element(
			page.getByText('Password must be at least 8 characters.').first()
		).toBeVisible();

		// Confirm the wizard did NOT advance
		expect(mockSetWizardStep).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Test 4: shows an error when the passwords do not match
	// -------------------------------------------------------------------------
	it('shows a mismatch error when the passwords do not match on the Profile step', async () => {
		wizardState.step = 1; // start at Profile step

		render(SetupWizard, { onclose: vi.fn() });

		// Fill password with a valid-length value
		// ProfileStep.svelte:36-41 — input id="wiz-profile-password"
		const passwordInput = page.getByLabelText(/Admin password/i);
		await passwordInput.fill('longpassword1');

		// Fill confirm-password with a different value
		// ProfileStep.svelte:43-49 — input id="wiz-profile-password2"
		const confirmInput = page.getByLabelText(/Confirm password/i);
		await confirmInput.fill('longpassword2');

		await page.getByRole('button', { name: 'Next' }).click();

		// SetupWizard.svelte:79-82: stepError = 'Passwords do not match.'
		// Note: ProfileStep also renders the same error text inside its own .wiz-error div,
		// so two elements match. Use .first() to avoid strict-mode violation.
		await expect.element(page.getByText('Passwords do not match.').first()).toBeVisible();

		// Confirm the wizard did NOT advance
		expect(mockSetWizardStep).not.toHaveBeenCalled();
	});
});
