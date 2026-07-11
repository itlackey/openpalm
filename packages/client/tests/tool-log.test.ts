/**
 * B9 [MEDIUM] (review 2026-07-10) — pure presentation helpers for the client's
 * ToolLog rail, ported from packages/ui/src/lib/chat/tool-strip.ts (trimmed to
 * the client's tool-only shape — no 'step' kind, since the transport only
 * extracts tool updates, not step updates).
 *
 * RED until src/lib/chat/tool-log.ts exists.
 */
import { describe, expect, test } from 'bun:test';
import type { ToolStateSnapshot } from '../src/lib/transport/index.ts';

async function loadModule() {
  return import('../src/lib/chat/tool-log.ts');
}

function tool(overrides: Partial<ToolStateSnapshot> = {}): ToolStateSnapshot {
  return {
    id: 'call-1',
    tool: 'bash',
    status: 'running',
    title: 'bash',
    detail: '',
    output: '',
    error: '',
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('toolIconType', () => {
  test('maps tool names to icon families', async () => {
    const { toolIconType } = await loadModule();
    expect(toolIconType('bash', 'running')).toBe('terminal');
    expect(toolIconType('grep', 'running')).toBe('search');
    expect(toolIconType('read', 'running')).toBe('file');
  });

  test('a failed/error status always wins', async () => {
    const { toolIconType } = await loadModule();
    expect(toolIconType('bash', 'error')).toBe('alert');
    expect(toolIconType('bash', 'failed')).toBe('alert');
  });
});

describe('toolStatusLabel', () => {
  test('maps raw OpenCode status names to display labels', async () => {
    const { toolStatusLabel } = await loadModule();
    expect(toolStatusLabel('completed')).toBe('completed');
    expect(toolStatusLabel('error')).toBe('failed');
    expect(toolStatusLabel('failed')).toBe('failed');
    expect(toolStatusLabel('pending')).toBe('queued');
    expect(toolStatusLabel('running')).toBe('running');
  });
});

describe('toolAriaLabel', () => {
  test('combines the tool name and status label for screen readers', async () => {
    const { toolAriaLabel } = await loadModule();
    expect(toolAriaLabel(tool({ title: 'Running command', status: 'running' }))).toBe(
      'Tool: Running command (running)'
    );
  });
});

describe('toolDetailRows', () => {
  test('includes name/status/tool-id rows, plus input and output when present', async () => {
    const { toolDetailRows } = await loadModule();
    const rows = toolDetailRows(
      tool({ title: 'Running ls', tool: 'bash', status: 'completed', detail: 'ls -la', output: 'file1\nfile2' })
    );
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('Name');
    expect(labels).toContain('Status');
    expect(labels).toContain('Tool ID');
    expect(labels).toContain('Input / Details');
    expect(labels).toContain('Output');
  });

  test('marks the error row with tone "error"', async () => {
    const { toolDetailRows } = await loadModule();
    const rows = toolDetailRows(tool({ status: 'error', error: 'command failed' }));
    const errorRow = rows.find((r) => r.label === 'Error');
    expect(errorRow).toMatchObject({ value: 'command failed', tone: 'error' });
  });
});

describe('relativeTimeLabel', () => {
  test('returns "just now" for very recent timestamps', async () => {
    const { relativeTimeLabel } = await loadModule();
    expect(relativeTimeLabel(Date.now() - 5000)).toBe('just now');
  });

  test('returns minutes/hours/days for older timestamps', async () => {
    const { relativeTimeLabel } = await loadModule();
    const now = Date.now();
    expect(relativeTimeLabel(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTimeLabel(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTimeLabel(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  test('returns "" for a falsy timestamp', async () => {
    const { relativeTimeLabel } = await loadModule();
    expect(relativeTimeLabel(0)).toBe('');
  });
});

describe('displayTitle', () => {
  test('never surfaces a raw command carrying secret material', async () => {
    const { displayTitle } = await loadModule();
    const title = displayTitle(tool({ tool: 'bash', title: 'curl -H "Authorization: token=abc123" example.com' }));
    expect(title.toLowerCase()).not.toContain('abc123');
  });

  test('recognizes a friendly command phrase', async () => {
    const { displayTitle } = await loadModule();
    expect(displayTitle(tool({ tool: 'bash', title: 'git config user.name foo' }))).toBe('Configured git');
  });
});
