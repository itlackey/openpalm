/**
 * HistoryManager factory.
 */
export type { HistoryManager, HistoryEntry } from './base.js';
export { SqliteHistoryManager } from './sqlite.js';

import type { HistoryManager } from './base.js';
import { SqliteHistoryManager } from './sqlite.js';
import { Database } from 'bun:sqlite';

/**
 * Create a HistoryManager.
 * @param dbOrPath — A bun:sqlite Database instance (for shared DB) or a file path string.
 *                    If null/undefined, history is disabled and a no-op manager is returned.
 */
export function createHistoryManager(dbOrPath: Database | string | null | undefined): HistoryManager | null {
  if (dbOrPath == null) return null;
  return new SqliteHistoryManager(dbOrPath);
}
