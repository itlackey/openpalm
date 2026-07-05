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
    await render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    await expect.element(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  });

  test('send button has aria-label "Send message"', async () => {
    await render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  });
});

describe('ChatInput — send button disabled state', () => {
  test('send button is disabled when input is empty', async () => {
    await render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  test('send button is disabled when input is only whitespace', async () => {
    await render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    const input = page.getByRole('textbox', { name: 'Message input' });
    await userEvent.type(input, '   ');
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  test('send button is enabled when input has text', async () => {
    await render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    const input = page.getByRole('textbox', { name: 'Message input' });
    await userEvent.type(input, 'hello');
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });

  test('send button is disabled while sending=true regardless of input', async () => {
    await render(ChatInput, { props: { sending: true, onSend: vi.fn() } });
    // The textarea stays enabled during sending (draft-while-sending) but the
    // send button is disabled independently via the sending prop.
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});

describe('ChatInput — draft while sending', () => {
  test('textarea stays enabled and typable while sending=true', async () => {
    await render(ChatInput, { props: { sending: true, onSend: vi.fn() } });
    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect.element(input).toBeEnabled();
    await userEvent.type(input, 'drafting next message');
    await expect.element(input).toHaveValue('drafting next message');
  });
});

describe('ChatInput — send behaviour', () => {
  test('calls onSend with trimmed text when button is clicked', async () => {
    const onSend = vi.fn();
    await render(ChatInput, { props: { sending: false, onSend } });
    const input = page.getByRole('textbox', { name: 'Message input' });
    await userEvent.type(input, '  hello world  ');
    await page.getByRole('button', { name: 'Send message' }).click();
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith('hello world');
  });

  test('clears input after send', async () => {
    await render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    const input = page.getByRole('textbox', { name: 'Message input' });
    await userEvent.type(input, 'hello');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.element(input).toHaveValue('');
  });

  test('does not call onSend when input is empty (button is disabled)', async () => {
    const onSend = vi.fn();
    await render(ChatInput, { props: { sending: false, onSend } });
    // Disabled button — verify state rather than clicking (Playwright waits for enabled before click)
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  test('Enter during IME composition does not submit', async () => {
    const onSend = vi.fn();
    const { container } = render(ChatInput, { props: { sending: false, onSend } });
    const input = container.querySelector('textarea')!;
    input.value = 'こんにちは';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })
    );
    expect(onSend).not.toHaveBeenCalled();
    await expect.element(input).toHaveValue('こんにちは');
  });
});
