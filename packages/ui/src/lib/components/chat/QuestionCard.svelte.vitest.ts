/**
 * QuestionCard component tests.
 *
 * Extracted from the chat page's inline question markup. Covers the single- vs
 * multi-question layouts and the status-gated disabled logic.
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import QuestionCard from './QuestionCard.svelte';
import type { PendingQuestionState } from '$lib/chat/chat-state.svelte.js';
import type { QuestionInfo } from '$lib/chat/oc-events.js';

function q(question: string, options: string[] = [], header = ''): QuestionInfo {
  return { question, header, options: options.map((label) => ({ label, description: '' })) };
}

function question(overrides: Partial<PendingQuestionState> = {}): PendingQuestionState {
  const questions = overrides.questions ?? [q('What is your name?', ['Alice', 'Bob'])];
  return {
    requestID: 'req-1',
    questions,
    status: 'pending',
    answers: new Array(questions.length).fill(''),
    message: '',
    ...overrides,
  };
}

const handlers = () => ({
  onOption: vi.fn(),
  onSelect: vi.fn(),
  onDraft: vi.fn(),
  onSubmit: vi.fn(),
  onReject: vi.fn(),
});

describe('QuestionCard — single question', () => {
  test('renders the question, its options, and the free-text hint', async () => {
    render(QuestionCard, { props: { question: question(), ...handlers() } });
    await expect.element(page.getByText('What is your name?')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Alice' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Bob' })).toBeVisible();
    await expect.element(page.getByText('or write your answer below')).toBeVisible();
  });

  test('clicking an option calls onOption with its label', async () => {
    const h = handlers();
    render(QuestionCard, { props: { question: question(), ...h } });
    await page.getByRole('button', { name: 'Alice' }).click();
    expect(h.onOption).toHaveBeenCalledWith('Alice');
  });

  test('option buttons are disabled when answered', async () => {
    render(QuestionCard, { props: { question: question({ status: 'answered' }), ...handlers() } });
    await expect.element(page.getByRole('button', { name: 'Alice' })).toBeDisabled();
  });
});

describe('QuestionCard — multiple questions', () => {
  const multi = () =>
    question({
      questions: [q('First?', ['A']), q('Second?')],
      answers: ['', ''],
    });

  test('renders every question plus submit / reject controls', async () => {
    render(QuestionCard, { props: { question: multi(), ...handlers() } });
    await expect.element(page.getByText('First?')).toBeVisible();
    await expect.element(page.getByText('Second?')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'submit answers' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: "can't answer" })).toBeVisible();
  });

  test('option select and submit / reject invoke the right handlers', async () => {
    const h = handlers();
    render(QuestionCard, { props: { question: multi(), ...h } });
    await page.getByRole('button', { name: 'A', exact: true }).click();
    expect(h.onSelect).toHaveBeenCalledWith(0, 'A');
    await page.getByRole('button', { name: 'submit answers' }).click();
    expect(h.onSubmit).toHaveBeenCalled();
    await page.getByRole('button', { name: "can't answer" }).click();
    expect(h.onReject).toHaveBeenCalled();
  });

  test('typing in a question input calls onDraft with index and value', async () => {
    const h = handlers();
    const { container } = render(QuestionCard, { props: { question: multi(), ...h } });
    const input = container.querySelectorAll<HTMLInputElement>('input.s-question-input')[1];
    expect(input).toBeInstanceOf(HTMLInputElement);
    if (!(input instanceof HTMLInputElement)) throw new Error('question input not found');
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.onDraft).toHaveBeenCalledWith(1, 'hello');
  });

  test('controls are disabled when submitting', async () => {
    render(QuestionCard, { props: { question: question({ questions: [q('First?', ['A']), q('Second?')], answers: ['', ''], status: 'submitting' }), ...handlers() } });
    await expect.element(page.getByRole('button', { name: 'submit answers' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'A', exact: true })).toBeDisabled();
  });
});
