import { describe, expect, test, vi, afterEach } from 'vitest';
import { formatTime, formatDateTime, formatRelativeTime } from './format-date.js';

describe('format-date', () => {
  afterEach(() => vi.useRealTimers());

  test('falsy inputs return empty string', () => {
    expect(formatTime(0)).toBe('');
    expect(formatDateTime(0)).toBe('');
    expect(formatRelativeTime(0)).toBe('');
  });

  test('formatTime / formatDateTime produce a non-empty locale string', () => {
    const ts = Date.UTC(2026, 5, 7, 15, 42);
    expect(formatTime(ts)).toMatch(/\d/);
    // Date + time string includes the year.
    expect(formatDateTime(ts)).toContain('2026');
  });

  test('formatRelativeTime covers each bucket boundary', () => {
    const now = Date.UTC(2026, 5, 7, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ago = (ms: number) => now - ms;
    const SEC = 1000, MIN = 60 * SEC, HR = 60 * MIN, DAY = 24 * HR;
    expect(formatRelativeTime(ago(5 * SEC))).toBe('just now');
    expect(formatRelativeTime(ago(5 * MIN))).toBe('5m ago');
    expect(formatRelativeTime(ago(3 * HR))).toBe('3h ago');
    expect(formatRelativeTime(ago(1 * DAY))).toBe('yesterday');
    expect(formatRelativeTime(ago(3 * DAY))).toBe('3d ago');
    expect(formatRelativeTime(ago(2 * 7 * DAY))).toBe('2w ago');
    expect(formatRelativeTime(ago(60 * DAY))).toBe('2mo ago');
    expect(formatRelativeTime(ago(800 * DAY))).toBe('2y ago');
  });
});
