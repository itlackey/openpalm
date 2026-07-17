import { describe, expect, it } from 'vitest';

import {
  normalizeToolStatus,
  toolStatusLabel,
  type ToolStripEntry,
} from './tool-strip.js';

function entry(overrides: Partial<ToolStripEntry> = {}): ToolStripEntry {
  return {
    id: 'tool-1',
    kind: 'tool',
    tool: 'deploy',
    status: 'completed',
    title: 'deploy',
    detail: '',
    output: '',
    error: '',
    updatedAt: 1000,
    ...overrides,
  };
}

describe('tool outcomes', () => {
  it('distinguishes terminal and active outcomes', () => {
    expect(normalizeToolStatus('completed')).toBe('succeeded');
    expect(normalizeToolStatus('running')).toBe('running');
    expect(normalizeToolStatus('failed')).toBe('failed');
    expect(normalizeToolStatus('completed-with-warning')).toBe('warning');
    expect(normalizeToolStatus('aborted')).toBe('stopped');
    expect(normalizeToolStatus('mystery')).toBe('uncertain');
  });

  it('does not present semantic ok:false output as completed', () => {
    const semanticFailure = entry({ output: JSON.stringify({ ok: false, error: 'rejected' }) });
    expect(toolStatusLabel(semanticFailure)).toBe('completed with warning');
    expect(toolStatusLabel(semanticFailure)).not.toBe('completed');
  });
});
