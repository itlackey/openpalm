/**
 * ReviewStep.svelte — rerun password field survives unmount/remount.
 *
 * Adversarial-review finding (CRITICAL): ReviewStep lives behind `{#if
 * s.currentStep === 3}` in routes/setup/+page.svelte, so navigating Back and
 * then Continue destroys and recreates the component — while
 * `uiLoginPassword`/`uiLoginPasswordDirty` live on the module-singleton
 * `setupState` store and survive that round trip untouched.
 *
 * `showRerunPasswordInput` used to be `$state(false)` unconditionally, so a
 * remount always re-rendered the collapsed "keep existing" (••••••••) view
 * even when the operator had already typed a new password on this same
 * rerun (store: dirty=true). Clicking Update from that collapsed view still
 * sent the typed password — `keepExistingUiLoginPassword` only checks
 * `isRerun && !uiLoginPasswordDirty` — silently rotating the login password
 * while the screen said "not changed unless you set a new one".
 */
import { describe, expect, test, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ReviewStep from './ReviewStep.svelte';
import { setupState } from '$lib/setup/setup-state.svelte.js';

afterEach(() => {
  setupState.reset();
});

describe('ReviewStep — rerun password unmount/remount', () => {
  test('a typed-but-unsaved password change survives unmount + remount', async () => {
    setupState.isRerun = true;
    setupState.updateUiLoginPassword('a-new-password');
    expect(setupState.uiLoginPasswordDirty).toBe(true);

    const { unmount } = render(ReviewStep);
    // First mount: already expanded (the operator just typed this), showing
    // the value — not the collapsed dots.
    await expect.element(page.getByLabelText('New sign-in password')).toHaveValue('a-new-password');

    // Simulate Back → Continue: ReviewStep unmounts, then remounts.
    await unmount();
    render(ReviewStep);

    // The remount must NOT silently re-collapse to "keep existing" — the
    // store is still dirty, so the expanded field (showing what will
    // actually be sent) must render again.
    await expect.element(page.getByLabelText('New sign-in password')).toHaveValue('a-new-password');
    await expect.element(
      page.getByText('Previously set — not changed unless you set a new one.'),
    ).not.toBeInTheDocument();
  });

  test('an untouched rerun still collapses to "keep existing" on remount', async () => {
    setupState.isRerun = true;
    expect(setupState.uiLoginPasswordDirty).toBe(false);

    const { unmount } = render(ReviewStep);
    await expect.element(
      page.getByText('Previously set — not changed unless you set a new one.'),
    ).toBeInTheDocument();

    await unmount();
    render(ReviewStep);

    await expect.element(
      page.getByText('Previously set — not changed unless you set a new one.'),
    ).toBeInTheDocument();
  });

  test('Cancel on an in-progress rerun change resets the store and the local flag together', async () => {
    setupState.isRerun = true;
    setupState.updateUiLoginPassword('short');
    expect(setupState.passwordValid).toBe(false);

    render(ReviewStep);
    await expect.element(page.getByLabelText('New sign-in password')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Cancel' }).click();

    expect(setupState.uiLoginPasswordDirty).toBe(false);
    expect(setupState.uiLoginPassword).toBe('');
    await expect.element(
      page.getByText('Previously set — not changed unless you set a new one.'),
    ).toBeInTheDocument();
  });
});
