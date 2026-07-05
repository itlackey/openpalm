import { describe, expect, test } from 'bun:test';
import {
  restoreSnapshot,
  hasSnapshot,
  hasArmedSnapshot,
  clearArmedSnapshot,
  snapshotTimestamp,
} from '../index.js';

describe('rollback barrel exports (0.2 — X1)', () => {
  test('exports hasArmedSnapshot/clearArmedSnapshot alongside the existing rollback helpers', () => {
    expect(typeof restoreSnapshot).toBe('function');
    expect(typeof hasSnapshot).toBe('function');
    expect(typeof hasArmedSnapshot).toBe('function');
    expect(typeof clearArmedSnapshot).toBe('function');
    expect(typeof snapshotTimestamp).toBe('function');
  });
});
