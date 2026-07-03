/**
 * ToolLog component tests.
 *
 * The chat-page tool accordion: a running list of tool/step actions with
 * collapsible details. Tests: empty state renders nothing, summaries render
 * per item, clicking a summary toggles its detail rows.
 */
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ToolLog from './ToolLog.svelte';
import type { ToolStripEntry } from '$lib/chat/tool-strip.js';

const NOW = Date.now();

function makeTool(id: string, toolName: string, overrides: Partial<ToolStripEntry> = {}): ToolStripEntry {
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
    ...overrides,
  };
}

describe('ToolLog', () => {
  test('renders nothing when there are no items', async () => {
    const { container } = await render(ToolLog, { props: { items: [] } });
    expect(container.querySelector('.tool-log')).toBeNull();
  });

  test('renders one accordion summary per item', async () => {
    const items = [makeTool('c1', 'bash'), makeTool('c2', 'read')];
    const { container } = await render(ToolLog, { props: { items } });
    expect(container.querySelectorAll('.tool-log-summary').length).toBe(2);
    // Details are collapsed by default.
    expect(container.querySelector('.tool-log-details')).toBeNull();
  });

  test('clicking a summary expands its details, clicking again collapses', async () => {
    const items = [makeTool('c1', 'bash', { detail: 'ls -la', output: 'file.txt' })];
    const { container } = await render(ToolLog, { props: { items } });
    const summary = container.querySelector<HTMLButtonElement>('.tool-log-summary');
    expect(summary).not.toBeNull();
    if (!summary) return;

    expect(summary.getAttribute('aria-expanded')).toBe('false');
    summary.click();
    await expect.poll(() => summary.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.tool-log-details')).not.toBeNull();

    summary.click();
    await expect.poll(() => summary.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.tool-log-details')).toBeNull();
  });

  test('running tools get the running modifier class', async () => {
    const items = [makeTool('c1', 'bash', { status: 'running' })];
    const { container } = await render(ToolLog, { props: { items } });
    expect(container.querySelector('.tool-log-item.running')).not.toBeNull();
  });

  test('failed tools get the failed modifier class', async () => {
    const items = [makeTool('c1', 'bash', { status: 'error', error: 'boom' })];
    const { container } = await render(ToolLog, { props: { items } });
    expect(container.querySelector('.tool-log-item.failed')).not.toBeNull();
  });
});
