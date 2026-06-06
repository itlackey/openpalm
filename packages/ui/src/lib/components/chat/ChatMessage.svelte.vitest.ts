/**
 * ChatMessage component tests.
 *
 * Every message the user sees passes through this component.
 * Tests: user/assistant rendering, markdown for assistant only, divider.
 */
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ChatMessage from './ChatMessage.svelte';
import type { ChatEntry } from '$lib/types.js';

const NOW = Date.now();

function userMsg(text: string): ChatEntry {
  return { id: '1', role: 'user', text, timestamp: NOW };
}

function assistantMsg(text: string): ChatEntry {
  return { id: '2', role: 'assistant', text, timestamp: NOW };
}

function divider(label: string): ChatEntry {
  return { id: '3', type: 'divider', label, timestamp: NOW };
}

describe('ChatMessage — user messages', () => {
  test('renders user message text', async () => {
    render(ChatMessage, { props: { entry: userMsg('hello world') } });
    await expect.element(page.getByText('hello world')).toBeVisible();
  });

  test('user message text is NOT markdown-rendered (verbatim)', async () => {
    const { container } = render(ChatMessage, { props: { entry: userMsg('**bold** text') } });
    // Text is rendered verbatim — check within this component's container only
    await expect.element(page.getByText('**bold** text')).toBeVisible();
    // No <strong> within this specific render (scoped to avoid cross-test pollution)
    expect(container.querySelector('strong')).toBeNull();
  });

  test('shows "You" in message meta', async () => {
    render(ChatMessage, { props: { entry: userMsg('hi') } });
    await expect.element(page.getByText(/You/)).toBeVisible();
  });
});

describe('ChatMessage — assistant messages', () => {
  test('renders assistant message text', async () => {
    render(ChatMessage, { props: { entry: assistantMsg('Hello there!') } });
    await expect.element(page.getByText('Hello there!')).toBeVisible();
  });

  test('assistant markdown is rendered as HTML (bold)', async () => {
    const { container } = render(ChatMessage, { props: { entry: assistantMsg('**bold**') } });
    // Scoped to this render's container to avoid cross-test pollution
    expect(container.querySelector('strong')).not.toBeNull();
  });

  test('shows "Assistant" in message meta', async () => {
    render(ChatMessage, { props: { entry: assistantMsg('hi') } });
    await expect.element(page.getByText(/Assistant/)).toBeVisible();
  });
});

describe('ChatMessage — divider', () => {
  test('renders divider with its label', async () => {
    render(ChatMessage, { props: { entry: divider('New conversation') } });
    await expect.element(page.getByText('New conversation')).toBeVisible();
  });

  test('divider has aria-label', async () => {
    const { container } = render(ChatMessage, { props: { entry: divider('Session start') } });
    expect(container.querySelector('[aria-label="Session start"]')).not.toBeNull();
  });
});
