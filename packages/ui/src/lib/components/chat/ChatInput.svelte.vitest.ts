/**
 * ChatInput component tests.
 *
 * Critical path: this is how users send messages.
 * Aria labels are load-bearing (stack tests rely on them).
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { userEvent } from 'vitest/browser';
import ChatInput from './ChatInput.svelte';

describe('ChatInput — aria labels (load-bearing)', () => {
  test('textarea has aria-label "Message input"', async () => {
    render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    await expect.element(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  });

  test('send button has aria-label "Send message"', async () => {
    render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  });
});

describe('ChatInput — send button disabled state', () => {
  test('send button is disabled when input is empty', async () => {
    render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  test('send button is disabled when input is only whitespace', async () => {
    render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    const input = page.getByRole('textbox', { name: 'Message input' });
    await userEvent.type(input, '   ');
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  test('send button is enabled when input has text', async () => {
    render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    const input = page.getByRole('textbox', { name: 'Message input' });
    await userEvent.type(input, 'hello');
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });

  test('send button is disabled while sending=true regardless of input', async () => {
    render(ChatInput, { props: { sending: true, onSend: vi.fn() } });
    // Input is also disabled when sending=true, so we can't type into it here.
    // The send button is disabled independently via the sending prop.
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});

describe('ChatInput — send behaviour', () => {
  test('calls onSend with trimmed text when button is clicked', async () => {
    const onSend = vi.fn();
    render(ChatInput, { props: { sending: false, onSend } });
    const input = page.getByRole('textbox', { name: 'Message input' });
    await userEvent.type(input, '  hello world  ');
    await page.getByRole('button', { name: 'Send message' }).click();
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith('hello world');
  });

  test('clears input after send', async () => {
    render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    const input = page.getByRole('textbox', { name: 'Message input' });
    await userEvent.type(input, 'hello');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.element(input).toHaveValue('');
  });

  test('does not call onSend when input is empty (button is disabled)', async () => {
    const onSend = vi.fn();
    render(ChatInput, { props: { sending: false, onSend } });
    // Disabled button — verify state rather than clicking (Playwright waits for enabled before click)
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
