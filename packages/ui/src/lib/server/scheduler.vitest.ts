import { describe, expect, test, vi } from 'vitest';
import { readAutomationLogs } from '@openpalm/lib';
import type { ControlPlaneState } from '@openpalm/lib';

const state = {} as ControlPlaneState;

describe('readAutomationLogs container boundary', () => {
  test('returns helper-provided newest complete lines', async () => {
    const read = vi.fn().mockResolvedValue(['newest', 'older']);
    await expect(readAutomationLogs(state, 'daily.yml', 50, read)).resolves.toEqual([
      'newest',
      'older',
    ]);
    expect(read).toHaveBeenCalledWith(state, 'daily.yml', 50);
  });

  test('preserves the requested limit', async () => {
    const read = vi.fn().mockResolvedValue(['one']);
    await readAutomationLogs(state, 'daily.yml', 5, read);
    expect(read).toHaveBeenCalledWith(state, 'daily.yml', 5);
  });

  test('rejects unschedulable IDs before crossing the container boundary', async () => {
    const read = vi.fn().mockResolvedValue([]);
    await expect(readAutomationLogs(state, 'nested.yml.yml', 50, read)).rejects.toThrow(
      'Invalid schedulable task file name',
    );
    expect(read).not.toHaveBeenCalled();
  });
});
