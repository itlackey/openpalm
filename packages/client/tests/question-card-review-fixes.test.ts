/**
 * P1 (review 2026-07-11) — QuestionCard.svelte's single-question branch
 * rendered options ONLY: no free-text input, no submit, no reject control.
 * A single options:[] question (no options at all) was therefore completely
 * unanswerable, and no single question — with or without options — could be
 * declined. Fix: mirror the multi-question `{:else}` branch's input/submit/
 * "can't answer" controls inside the single-question branch too.
 *
 * packages/client has no component-render harness (bun:test only), so this
 * is a source "pin" test — same house pattern as chat-page-markup.test.ts.
 *
 * RED until QuestionCard.svelte's single-question branch renders all three.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/lib/components/chat/QuestionCard.svelte', import.meta.url));

function source(): string {
  return readFileSync(PATH, 'utf8');
}

/** The single-question branch's markup: from the `{#if ... length === 1 ...}`
 *  guard up to (not including) the `{:else}` that starts the multi-question
 *  branch. */
function singleQuestionBranch(): string {
  const src = source();
  const start = src.indexOf('{#if question.questions.length === 1');
  const end = src.indexOf('{:else}', start);
  if (start === -1 || end === -1) throw new Error('could not locate the single-question branch in QuestionCard.svelte');
  return src.slice(start, end);
}

describe('QuestionCard.svelte — P1 single-question branch is answerable and rejectable', () => {
  test('renders a free-text input wired to onDraft(0, ...)', () => {
    const branch = singleQuestionBranch();
    expect(branch).toMatch(/<input\b/);
    expect(branch).toMatch(/onDraft\(0,/);
  });

  test('renders a submit control wired to onSubmit()', () => {
    const branch = singleQuestionBranch();
    expect(branch).toMatch(/onclick=\{(?:\(\)\s*=>\s*)?onSubmit\(\)\}/);
  });

  test('renders a reject ("can\'t answer") control wired to onReject()', () => {
    const branch = singleQuestionBranch();
    expect(branch).toMatch(/onclick=\{(?:\(\)\s*=>\s*)?onReject\(\)\}/);
    expect(branch.toLowerCase()).toContain("can't answer");
  });

  test('the free-text input/submit/reject controls all respect the locked state', () => {
    const branch = singleQuestionBranch();
    // Every interactive control in the branch must be disable-able while
    // submitting/answered/rejected — a naive port could add the new
    // controls without carrying the existing `locked` guard over.
    const controlCount = (branch.match(/disabled=\{locked\}/g) ?? []).length;
    // input + submit + reject = at least 3 (options, if any, add more).
    expect(controlCount).toBeGreaterThanOrEqual(3);
  });
});
