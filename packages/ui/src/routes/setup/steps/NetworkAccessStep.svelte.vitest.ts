/**
 * #563 D5 — NetworkAccessStep.svelte: the wizard's network-access preset
 * selector, rendered as a section of the Finish step (ReviewStep).
 *
 * Red reason: `./NetworkAccessStep.svelte` does not exist yet — the import
 * fails. Mirrors `Screen1ModelsStep.svelte.vitest.ts` (vitest-browser-svelte,
 * store-driven — the component takes no props, per D5/ReviewStep pattern).
 */
import { describe, expect, test, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import NetworkAccessStep from './NetworkAccessStep.svelte';
import { setupState } from '$lib/setup/setup-state.svelte.js';

afterEach(() => {
  setupState.reset();
});

describe('NetworkAccessStep — preset selector (#563 T54)', () => {
  test('T54: renders all four presets with "This PC only" selected by default', async () => {
    render(NetworkAccessStep);

    await expect.element(page.getByText('This PC only')).toBeVisible();
    await expect.element(page.getByText('Home network, with password')).toBeVisible();
    await expect.element(page.getByText('Home network, open access')).toBeVisible();
    await expect.element(page.getByText('Shared network, guardian protected')).toBeVisible();

    const defaultRadio = page.getByRole('radio', { name: /This PC only/i });
    await expect.element(defaultRadio).toBeChecked();
  });
});

describe('NetworkAccessStep — home-password reveals an editable, pre-filled password (#563 T55)', () => {
  test('T55: selecting "Home network, with password" reveals an editable, pre-filled password input', async () => {
    render(NetworkAccessStep);

    await page.getByRole('radio', { name: /Home network, with password/i }).click();

    const passwordInput = page.getByLabelText(/password/i);
    await expect.element(passwordInput).toBeVisible();
    const value = await passwordInput.element().getAttribute('value');
    expect(value, 'expected the password field to be pre-filled, not blank').toBeTruthy();

    // The user CAN type over it — this is not a read-only/locked field.
    await passwordInput.fill('my-own-password');
    await expect.element(passwordInput).toHaveValue('my-own-password');
  });
});

describe('NetworkAccessStep — home-open risk warning + required acknowledgement (#563 T56)', () => {
  test('T56: selecting "Home network, open access" reveals the risk warning and requires the acknowledgement checkbox', async () => {
    render(NetworkAccessStep);

    await page.getByRole('radio', { name: /Home network, open access/i }).click();

    // Explicit risk warning is visible (D5: "explicit risk-acknowledgement
    // checkbox before Install enables").
    await expect.element(page.getByText(/without a password|open access|anyone on your network/i)).toBeVisible();

    const ackCheckbox = page.getByRole('checkbox');
    await expect.element(ackCheckbox).not.toBeChecked();
    expect(setupState.networkChoiceValid).toBe(false);

    await ackCheckbox.click();
    await expect.element(ackCheckbox).toBeChecked();
    expect(setupState.networkChoiceValid).toBe(true);
  });
});

describe('NetworkAccessStep — shared-guardian copy (#563 T57)', () => {
  test('T57: shared-guardian copy states the assistant stays private on this PC', async () => {
    render(NetworkAccessStep);

    await page.getByRole('radio', { name: /Shared network, guardian protected/i }).click();

    await expect
      .element(page.getByText(/assistant.*(stays|remains).*(private|loopback|this (pc|computer))/i))
      .toBeVisible();
  });
});
