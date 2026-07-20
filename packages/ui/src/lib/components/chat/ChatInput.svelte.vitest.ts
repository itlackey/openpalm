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

describe('ChatInput — stop button', () => {
  test('shows a stop button instead of send while sending, when onStop is provided', async () => {
    await render(ChatInput, { props: { sending: true, onSend: vi.fn(), onStop: vi.fn() } });
    await expect.element(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  test('calls onStop when the stop button is clicked', async () => {
    const onStop = vi.fn();
    await render(ChatInput, { props: { sending: true, onSend: vi.fn(), onStop } });
    await page.getByRole('button', { name: 'Stop generating' }).click();
    expect(onStop).toHaveBeenCalledOnce();
  });

  test('falls back to the (disabled) send button while sending when onStop is not provided', async () => {
    await render(ChatInput, { props: { sending: true, onSend: vi.fn() } });
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
  });

  test('does not show the stop button for a single-question pending state (questionPending=true)', async () => {
    await render(ChatInput, {
      props: { sending: true, questionPending: true, onSend: vi.fn(), onStop: vi.fn() },
    });
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
  });
});

describe('ChatInput — bindable draft', () => {
  test('an initial draft prop prefills the textarea and enables send', async () => {
    await render(ChatInput, { props: { sending: false, onSend: vi.fn(), draft: 'dictated text' } });
    await expect.element(page.getByRole('textbox', { name: 'Message input' })).toHaveValue('dictated text');
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });
});

describe('ChatInput — focused composer controls', () => {
  test('shows a two-pixel keyboard focus indicator on the textarea', async () => {
    const { container } = render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    const input = container.querySelector('textarea');
    expect(input).toBeInstanceOf(HTMLTextAreaElement);
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('textarea not found');
    input.style.setProperty('--s-seal', '#98420a');
    input.focus();
    const style = getComputedStyle(input);
    expect(style.outlineStyle).not.toBe('none');
    expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
  });

  test('keeps voice and conversation controls out of the composer', async () => {
    const { container } = render(ChatInput, { props: { sending: false, onSend: vi.fn() } });
    expect(container.querySelector('[aria-label="Start recording"]')).toBeNull();
    expect(container.querySelector('[aria-label="Start conversation mode"]')).toBeNull();
    await expect.element(page.getByRole('button', { name: 'Send message' })).toBeVisible();
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
    const input = container.querySelector('textarea');
    expect(input).toBeInstanceOf(HTMLTextAreaElement);
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('textarea not found');
    input.value = 'こんにちは';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })
    );
    expect(onSend).not.toHaveBeenCalled();
    await expect.element(input).toHaveValue('こんにちは');
  });
});
