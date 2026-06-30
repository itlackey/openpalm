/**
 * ChatMessage component tests.
 *
 * Every message the user sees passes through this component.
 * Tests: user/assistant rendering, markdown for assistant only, divider.
 *
 * Tool activity is NOT rendered inline by this component — it lives only in
 * the chat-page tool accordion (ToolLog). These tests assert the thread stays
 * free of inline tool strips even when entries carry toolStates.
 */
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ChatMessage from './ChatMessage.svelte';
import type { ChatEntry, ChatToolGroup } from '$lib/types.js';
import type { ToolStripEntry } from '$lib/chat/tool-strip.js';

const NOW = Date.now();

function userMsg(text: string): ChatEntry {
  return { id: '1', role: 'user', text, timestamp: NOW };
}

function assistantMsg(text: string): ChatEntry {
  return { id: '2', role: 'assistant', text, timestamp: NOW };
}

function assistantMsgWithTools(text: string, tools: ToolStripEntry[]): ChatEntry {
  return { id: '2', role: 'assistant', text, timestamp: NOW, toolStates: tools };
}

function divider(label: string): ChatEntry {
  return { id: '3', type: 'divider', label, timestamp: NOW };
}

function toolGroup(tools: ToolStripEntry[]): ChatToolGroup {
  return { id: '4', type: 'tool-group', toolStates: tools, timestamp: NOW };
}

function makeTool(id: string, toolName: string): ToolStripEntry {
  return {
    id,
    kind: 'tool',
    tool: toolName,
    status: 'completed',
    title: toolName,
    detail: '',
    output: 'result',
    error: '',
    updatedAt: NOW,
  };
}

describe('ChatMessage — user messages', () => {
  test('renders user message text', async () => {
    await render(ChatMessage, { props: { entry: userMsg('hello world') } });
    await expect.element(page.getByText('hello world')).toBeVisible();
  });

  test('user message text is NOT markdown-rendered (verbatim)', async () => {
    const { container } = await render(ChatMessage, { props: { entry: userMsg('**bold** text') } });
    // Text is rendered verbatim — check within this component's container only
    await expect.element(page.getByText('**bold** text')).toBeVisible();
    // No <strong> within this specific render (scoped to avoid cross-test pollution)
    expect(container.querySelector('strong')).toBeNull();
  });

  test('shows "You" in message meta', async () => {
    await render(ChatMessage, { props: { entry: userMsg('hi') } });
    await expect.element(page.getByText(/You/)).toBeVisible();
  });
});

describe('ChatMessage — assistant messages', () => {
  test('renders assistant message text', async () => {
    await render(ChatMessage, { props: { entry: assistantMsg('Hello there!') } });
    await expect.element(page.getByText('Hello there!')).toBeVisible();
  });

  test('assistant markdown is rendered as HTML (bold)', async () => {
    const { container } = await render(ChatMessage, { props: { entry: assistantMsg('**bold**') } });
    // Scoped to this render's container to avoid cross-test pollution
    expect(container.querySelector('strong')).not.toBeNull();
  });

  test('shows "Assistant" in message meta', async () => {
    await render(ChatMessage, { props: { entry: assistantMsg('hi') } });
    await expect.element(page.getByText(/Assistant/)).toBeVisible();
  });
});

describe('ChatMessage — divider', () => {
  test('renders divider with its label', async () => {
    await render(ChatMessage, { props: { entry: divider('New conversation') } });
    await expect.element(page.getByText('New conversation')).toBeVisible();
  });

  test('divider has aria-label', async () => {
    const { container } = await render(ChatMessage, { props: { entry: divider('Session start') } });
    expect(container.querySelector('[aria-label="Session start"]')).not.toBeNull();
  });
});

describe('ChatMessage — tool activity is panel-only (not inline)', () => {
  test('assistant text renders but tools do NOT appear inline when toolStates present', async () => {
    const tools = [makeTool('c1', 'bash'), makeTool('c2', 'read')];
    const { container } = await render(ChatMessage, {
      props: { entry: assistantMsgWithTools('Here is the result.', tools) },
    });
    await expect.element(page.getByText('Here is the result.')).toBeVisible();
    // Tool activity lives in the left rail / drawer (ToolLog), never inline.
    expect(container.querySelector('.tool-icon-btn')).toBeNull();
    expect(container.querySelector('.tool-log')).toBeNull();
  });

  test('renders no tool markup when toolStates is absent', async () => {
    const { container } = await render(ChatMessage, { props: { entry: assistantMsg('No tools.') } });
    await expect.element(page.getByText('No tools.')).toBeVisible();
    expect(container.querySelector('.tool-icon-btn')).toBeNull();
  });

  test('orphan tool-group renders nothing in the thread', async () => {
    const tools = [makeTool('c1', 'bash'), makeTool('c2', 'grep'), makeTool('c3', 'read')];
    const { container } = await render(ChatMessage, { props: { entry: toolGroup(tools) } });
    expect(container.querySelector('.tool-icon-btn')).toBeNull();
    expect(container.querySelector('[aria-label="Assistant tool activity"]')).toBeNull();
    expect(container.textContent?.trim()).toBe('');
  });
});
