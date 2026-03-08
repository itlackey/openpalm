/**
 * SQLite history manager — uses bun:sqlite for audit trail storage.
 * Can share a Database instance with SqliteVecStore (single .db file).
 */
import { Database } from 'bun:sqlite';
import type { HistoryManager, HistoryEntry } from './base.js';

export class SqliteHistoryManager implements HistoryManager {
  private db: Database;
  private ownsDb: boolean;

  /**
   * @param dbOrPath — Either an existing Database instance (shared with vector store)
   *                    or a file path string to open a new connection.
   */
  constructor(dbOrPath: Database | string) {
    if (typeof dbOrPath === 'string') {
      this.db = new Database(dbOrPath);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        previous_value TEXT,
        new_value TEXT,
        action TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        is_deleted INTEGER DEFAULT 0
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_history_memory_id ON history(memory_id)`,
    );
  }

  async addHistory(
    memoryId: string,
    previousValue: string | null,
    newValue: string | null,
    action: string,
    createdAt?: string,
    updatedAt?: string,
    isDeleted?: number,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO history (memory_id, previous_value, new_value, action, created_at, updated_at, is_deleted)
         VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?)`,
      )
      .run(
        memoryId,
        previousValue,
        newValue,
        action,
        createdAt ?? null,
        updatedAt ?? null,
        isDeleted ?? 0,
      );
  }

  async getHistory(memoryId: string): Promise<HistoryEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT id, memory_id, previous_value, new_value, action, created_at, updated_at, is_deleted
         FROM history WHERE memory_id = ? ORDER BY id ASC`,
      )
      .all(memoryId) as RawHistoryRow[];

    return rows.map((r) => ({
      id: r.id,
      memoryId: r.memory_id,
      previousValue: r.previous_value,
      newValue: r.new_value,
      action: r.action,
      createdAt: r.created_at ?? '',
      updatedAt: r.updated_at ?? '',
      isDeleted: r.is_deleted ?? 0,
    }));
  }

  async reset(): Promise<void> {
    this.db.exec('DELETE FROM history');
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}

type RawHistoryRow = {
  id: number;
  memory_id: string;
  previous_value: string | null;
  new_value: string | null;
  action: string;
  created_at: string | null;
  updated_at: string | null;
  is_deleted: number | null;
};
