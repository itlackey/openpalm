/**
 * Screen1ModelsStep regression tests.
 *
 * Guards the dead-UI cleanup:
 *  - The inert detection-timeout banner (driven by a hardcoded-false constant)
 *    is gone — its text must never render.
 *  - The system-check retry button is behavior-preserving: it still reads
 *    "Retry" and never shows the removed inert "Checking…" state.
 */
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Screen1ModelsStep from './Screen1ModelsStep.svelte';
import { setupState } from '$lib/setup/setup-state.svelte.js';

describe('Screen1ModelsStep — dead timeout UI removed', () => {
  test('never renders the inert detection-timeout banner', async () => {
    render(Screen1ModelsStep);

    await expect.element(page.getByText(/Detection timed out/i)).not.toBeInTheDocument();
    await expect.element(page.getByText(/Re-run detection/i)).not.toBeInTheDocument();
  });

  test('system-check retry button reads "Retry" with no inert "Checking…" state', async () => {
    setupState.systemCheckPassed = false;
    setupState.step0Error = 'System check failed.';
    render(Screen1ModelsStep);

    await expect
      .element(page.getByText(/System check failed\./i), { timeout: 5000 })
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect.element(page.getByText(/Checking…/i)).not.toBeInTheDocument();
  });
});
