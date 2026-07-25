/**
 * NetworkAccessStep.svelte — the wizard's access toggles, rendered as a
 * section of the Finish step (ReviewStep).
 *
 * The behaviour under test is progressive disclosure: a home user is asked ONE
 * question, and the switches that would be meaningless in their configuration
 * are not shown at all.
 */
import { describe, expect, test, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import NetworkAccessStep from './NetworkAccessStep.svelte';
import { setupState } from '$lib/setup/setup-state.svelte.js';

afterEach(() => {
  setupState.reset();
});

describe('NetworkAccessStep — the always-visible question', () => {
  test('shows exactly one toggle by default, unchecked', async () => {
    render(NetworkAccessStep);

    const networkAccess = page.getByRole('checkbox');
    await expect.element(networkAccess).toBeInTheDocument();
    expect(await networkAccess.elements()).toHaveLength(1);
    await expect.element(networkAccess).not.toBeChecked();
  });

  test('a fresh install opens nothing — the default needs no interaction', () => {
    expect(setupState.access).toEqual({
      networkAccess: false,
      assistantDirect: false,
      guardianNetwork: false,
      guardianOpenaiApi: false,
    });
  });

  test('checking it flips only that toggle, and marks the step touched', async () => {
    render(NetworkAccessStep);

    await page.getByRole('checkbox').click();

    expect(setupState.access.networkAccess).toBe(true);
    // Nothing cascades — this was the defect the preset model had.
    expect(setupState.access.assistantDirect).toBe(false);
    expect(setupState.access.guardianNetwork).toBe(false);
    expect(setupState.access.guardianOpenaiApi).toBe(false);
    expect(setupState.networkDirty).toBe(true);
  });
});

describe('NetworkAccessStep — progressive disclosure', () => {
  test('everything except the one question is behind Advanced', async () => {
    render(NetworkAccessStep);

    for (const label of [
      'Let other devices reach the guardian',
      'Enable the OpenAI-compatible API',
      'Allow direct connections to the assistant API',
    ]) {
      await expect.element(page.getByText(label)).not.toBeInTheDocument();
    }
  });

  test('Advanced reveals the guardian and direct-assistant toggles', async () => {
    // These are NOT gated on "a guardian integration is enabled": publishing a
    // front door is the statement of intent, and performSetup enables the
    // addon that makes it true.
    render(NetworkAccessStep);

    await page.getByRole('button', { name: /advanced/i }).click();

    await expect.element(page.getByText('Let other devices reach the guardian')).toBeInTheDocument();
    await expect.element(page.getByText('Enable the OpenAI-compatible API')).toBeInTheDocument();
    await expect.element(
      page.getByText('Allow direct connections to the assistant API'),
    ).toBeInTheDocument();
  });

  test('an advanced toggle flips only itself', async () => {
    render(NetworkAccessStep);
    await page.getByRole('button', { name: /advanced/i }).click();
    await page.getByRole('checkbox', { name: /reach the guardian/i }).click();

    expect(setupState.access.guardianNetwork).toBe(true);
    expect(setupState.access.networkAccess).toBe(false);
    expect(setupState.access.guardianOpenaiApi).toBe(false);
    expect(setupState.access.assistantDirect).toBe(false);
  });

  test('enabling direct exposure names the plain-HTTP risk rather than burying it', async () => {
    render(NetworkAccessStep);
    await page.getByRole('button', { name: /advanced/i }).click();
    await page.getByRole('checkbox', { name: /direct connections/i }).click();

    await expect.element(page.getByRole('alert')).toBeInTheDocument();
    expect(setupState.access.assistantDirect).toBe(true);
  });
});
