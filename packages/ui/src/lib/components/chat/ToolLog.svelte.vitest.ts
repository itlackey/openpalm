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

  test('keeps the rail content chain inside a narrow container', async () => {
    const items = [makeTool('c1', 'read')];
    const { container } = await render(ToolLog, { props: { items } });
    container.style.width = '247px';
    const selectors = ['.tool-log', '.tool-log-list', '.tool-log-item', '.tool-log-summary'];

    for (const selector of selectors) {
      const element = container.querySelector<HTMLElement>(selector);
      expect(element).not.toBeNull();
      if (!element) continue;
      const style = getComputedStyle(element);
      expect(style.boxSizing, selector).toBe('border-box');
      expect(Number.parseFloat(style.minWidth), selector).toBe(0);
      expect(element.scrollWidth, selector).toBeLessThanOrEqual(element.clientWidth + 1);
    }
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

  test('labels semantic ok:false output as completed with warning', async () => {
    const items = [
      makeTool('c1', 'deploy', {
        status: 'completed',
        output: JSON.stringify({ ok: false, error: 'deploy rejected' }),
      }),
    ];
    const { container } = await render(ToolLog, { props: { items } });
    const summary = container.querySelector<HTMLButtonElement>('.tool-log-summary');

    expect(container.querySelector('.tool-log-item.warning')).not.toBeNull();
    expect(container.querySelector('.tool-log-status')?.textContent).toBe('completed with warning');
    expect(summary?.getAttribute('aria-label')).toContain('completed with warning');
    expect(summary?.getAttribute('aria-label')).not.toContain('(completed)');
  });

  test('announces status changes and connects summaries to their detail regions', async () => {
    const items = [makeTool('c1', 'bash', { status: 'uncertain' })];
    const { container } = await render(ToolLog, { props: { items } });
    const summary = container.querySelector<HTMLButtonElement>('.tool-log-summary');
    const liveRegion = container.querySelector('[role="status"]');

    expect(liveRegion?.textContent).toContain('Bash: outcome uncertain');
    expect(container.querySelector('.tool-log-item.uncertain')).not.toBeNull();
    summary?.click();
    await expect.poll(() => summary?.getAttribute('aria-expanded')).toBe('true');
    const detailsId = summary?.getAttribute('aria-controls');
    expect(detailsId).toBeTruthy();
    expect(container.querySelector(`#${detailsId}`)?.getAttribute('role')).toBe('region');
  });
});
