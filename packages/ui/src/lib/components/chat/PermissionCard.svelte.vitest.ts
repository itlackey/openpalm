/**
 * PermissionCard component tests.
 *
 * Extracted from the chat page's inline permission markup. These guard the
 * status-gated disabled logic and the in-flight button labels.
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import PermissionCard from './PermissionCard.svelte';
import type { PendingPermissionState } from '$lib/chat/chat-state.svelte.js';

function permission(overrides: Partial<PendingPermissionState> = {}): PendingPermissionState {
  return {
    requestID: 'req-1',
    permission: 'run bash command',
    patterns: ['git status'],
    always: ['git *'],
    tool: 'bash',
    detail: 'The assistant wants to run a command.',
    status: 'pending',
    decision: '',
    message: '',
    ...overrides,
  };
}

describe('PermissionCard', () => {
  test('renders the permission title, detail, and patterns', async () => {
    render(PermissionCard, { props: { permission: permission(), actionInFlight: null, onReply: () => {} } });
    await expect.element(page.getByText('run bash command')).toBeVisible();
    await expect.element(page.getByText('The assistant wants to run a command.')).toBeVisible();
    await expect.element(page.getByText('git status')).toBeVisible();
  });

  test('buttons are enabled and calls onReply with the chosen decision when pending', async () => {
    const onReply = vi.fn();
    render(PermissionCard, { props: { permission: permission(), actionInFlight: null, onReply } });

    const allowOnce = page.getByRole('button', { name: 'allow this once' });
    await expect.element(allowOnce).toBeEnabled();
    await allowOnce.click();
    expect(onReply).toHaveBeenCalledWith('once');

    await page.getByRole('button', { name: 'always allow' }).click();
    expect(onReply).toHaveBeenCalledWith('always');

    await page.getByRole('button', { name: 'deny' }).click();
    expect(onReply).toHaveBeenCalledWith('reject');
  });

  test('all buttons are disabled when submitting', async () => {
    render(PermissionCard, {
      props: { permission: permission({ status: 'submitting' }), actionInFlight: 'once', onReply: () => {} },
    });
    await expect.element(page.getByRole('button', { name: 'sending…' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'always allow' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'deny' })).toBeDisabled();
  });

  test('all buttons are disabled when resolved', async () => {
    const { container } = render(PermissionCard, {
      props: { permission: permission({ status: 'resolved' }), actionInFlight: null, onReply: () => {} },
    });
    for (const btn of container.querySelectorAll('button')) {
      expect(btn.disabled).toBe(true);
    }
  });

  test('shows the in-flight label only on the acting button', async () => {
    render(PermissionCard, {
      props: { permission: permission({ status: 'submitting' }), actionInFlight: 'reject', onReply: () => {} },
    });
    // reject button shows sending…; the others keep their labels.
    await expect.element(page.getByRole('button', { name: 'sending…' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'allow this once' })).toBeVisible();
  });
});
