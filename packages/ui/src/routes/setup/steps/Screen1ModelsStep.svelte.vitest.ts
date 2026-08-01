/**
 * Screen1ModelsStep regression tests.
 *
 * Guards the dead-UI cleanup:
 *  - The inert detection-timeout banner (driven by a hardcoded-false constant)
 *    is gone — its text must never render.
 *  - G-series: the "system check failure" inline alert (and its "Retry"
 *    button) read `step0Error`, a field nothing in production ever wrote —
 *    Screen1ModelsStep only ever mounts after System Check has already
 *    passed. Both the field and this now-unreachable alert were removed;
 *    this guards that the dead "Checking…" state stays gone too.
 */
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Screen1ModelsStep from './Screen1ModelsStep.svelte';

describe('Screen1ModelsStep — dead timeout UI removed', () => {
  test('never renders the inert detection-timeout banner', async () => {
    render(Screen1ModelsStep);

    await expect.element(page.getByText(/Detection timed out/i)).not.toBeInTheDocument();
    await expect.element(page.getByText(/Re-run detection/i)).not.toBeInTheDocument();
  });

  test('never renders the removed system-check-failure alert or its dead "Checking…" state', async () => {
    render(Screen1ModelsStep);

    await expect.element(page.getByText(/System check failed/i)).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await expect.element(page.getByText(/Checking…/i)).not.toBeInTheDocument();
  });
});
