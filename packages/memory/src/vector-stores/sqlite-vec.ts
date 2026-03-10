/**
 * sqlite-vec vector store — uses bun:sqlite + sqlite-vec extension for
 * approximate nearest-neighbor search in a single .db file.
 *
 * Schema:
 *   vec_metadata — stores payload, user/agent/run IDs, timestamps
 *   vec_store    — sqlite-vec virtual table for vector similarity search
 */
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import type { VectorStore } from './base.js';
import type { SearchFilters, VectorStoreResult, VectorStoreProviderConfig } from '../types.js';

export class SqliteVecStore implements VectorStore {
  private db: Database;
  private dimensions: number;
  private collectionName: string;
  private tableMeta: string;
  private tableVec: string;

  constructor(config: VectorStoreProviderConfig['config']) {
    const dbPath = config.dbPath ?? './memory.db';
    this.dimensions = config.dimensions ?? 1536;
    const rawName = config.collectionName ?? 'memory';
    // Validate collection name to prevent SQL injection via table identifiers
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawName)) {
      throw new Error(`Invalid collection name "${rawName}": must be alphanumeric/underscores only`);
    }
    this.collectionName = rawName;
    this.tableMeta = `${this.collectionName}_metadata`;
    this.tableVec = `${this.collectionName}_vec`;

    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    // bun:sqlite's loadExtension appends the platform suffix (.so/.dylib/.dll)
    // automatically, but sqlite-vec's load() passes the full path including the
    // suffix, causing a double extension (vec0.so.so). Load directly with the
    // suffix stripped so bun:sqlite can append it correctly.
    const extPath = sqliteVec.getLoadablePath();
    const stripped = extPath.replace(/\.(so|dylib|dll)$/, '');
    this.db.loadExtension(stripped);
  }

  /** Expose the underlying Database instance (for sharing with HistoryManager). */
  getDb(): Database {
    return this.db;
  }

  async initialize(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableMeta} (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        hash TEXT,
        data TEXT,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${this.collectionName}_user ON ${this.tableMeta}(user_id)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${this.collectionName}_agent ON ${this.tableMeta}(agent_id)`,
    );

    // Create the sqlite-vec virtual table.
    // vec0 uses TEXT primary key and float[N] for the embedding column.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableVec} USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}]
      )
    `);
  }

  async insert(
    vectors: number[][],
    ids: string[],
    payloads: Record<string, unknown>[],
  ): Promise<void> {
    // Validate array lengths match
    if (vectors.length !== ids.length || vectors.length !== payloads.length) {
      throw new Error(
        `Insert arrays must have equal lengths: vectors=${vectors.length}, ids=${ids.length}, payloads=${payloads.length}`,
      );
    }
    // Validate vector dimensions
    for (let i = 0; i < vectors.length; i++) {
      if (vectors[i].length !== this.dimensions) {
        throw new Error(
          `Vector at index ${i} has ${vectors[i].length} dimensions, expected ${this.dimensions}`,
        );
      }
    }

    const insertMeta = this.db.prepare(`
      INSERT OR REPLACE INTO ${this.tableMeta}
        (id, user_id, agent_id, run_id, hash, data, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    const insertVec = this.db.prepare(`
      INSERT OR REPLACE INTO ${this.tableVec} (id, embedding) VALUES (?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        const payload = payloads[i];
        insertMeta.run(
          ids[i],
          (payload.user_id as string) ?? null,
          (payload.agent_id as string) ?? null,
          (payload.run_id as string) ?? null,
          (payload.hash as string) ?? null,
          (payload.data as string) ?? null,
          JSON.stringify(payload.metadata ?? {}),
          );
        insertVec.run(ids[i], new Float32Array(vectors[i]));
      }
    });
    transaction();
  }

  async search(
    query: number[],
    limit: number = 10,
    filters?: SearchFilters,
  ): Promise<VectorStoreResult[]> {
    if (query.length !== this.dimensions) {
      throw new Error(
        `Query vector has ${query.length} dimensions, expected ${this.dimensions}`,
      );
    }

    const hasFilters = filters?.userId || filters?.agentId || filters?.runId;

    // When filters are active, oversample more aggressively and page
    // through results to avoid returning too few matches.
    const oversample = hasFilters ? 10 : 3;
    const maxFetch = limit * oversample;

    // sqlite-vec MATCH query returns id + distance (lower = more similar)
    const vecRows = this.db
      .prepare(
        `SELECT id, distance FROM ${this.tableVec}
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(new Float32Array(query), maxFetch) as { id: string; distance: number }[];

    if (vecRows.length === 0) return [];

    // Fetch metadata for matched IDs
    const placeholders = vecRows.map(() => '?').join(',');
    const metaRows = this.db
      .prepare(
        `SELECT id, user_id, agent_id, run_id, hash, data, metadata, created_at, updated_at
         FROM ${this.tableMeta}
         WHERE id IN (${placeholders})`,
      )
      .all(...vecRows.map((r) => r.id)) as MetaRow[];

    const metaMap = new Map(metaRows.map((r) => [r.id, r]));

    // Build results, applying filters in app code
    const results: VectorStoreResult[] = [];
    for (const vr of vecRows) {
      const meta = metaMap.get(vr.id);
      if (!meta) continue;

      if (filters?.userId && meta.user_id !== filters.userId) continue;
      if (filters?.agentId && meta.agent_id !== filters.agentId) continue;
      if (filters?.runId && meta.run_id !== filters.runId) continue;

      // Convert distance to a 0-1 similarity score (cosine distance → similarity)
      const score = 1 - vr.distance;

      results.push({
        id: vr.id,
        payload: {
          user_id: meta.user_id,
          agent_id: meta.agent_id,
          run_id: meta.run_id,
          hash: meta.hash,
          data: meta.data,
          metadata: safeParseJson(meta.metadata),
          created_at: meta.created_at,
          updated_at: meta.updated_at,
        },
        score,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  async get(vectorId: string): Promise<VectorStoreResult | null> {
    const row = this.db
      .prepare(
        `SELECT id, user_id, agent_id, run_id, hash, data, metadata, created_at, updated_at
         FROM ${this.tableMeta} WHERE id = ?`,
      )
      .get(vectorId) as MetaRow | null;

    if (!row) return null;

    return {
      id: row.id,
      payload: {
        user_id: row.user_id,
        agent_id: row.agent_id,
        run_id: row.run_id,
        hash: row.hash,
        data: row.data,
        metadata: safeParseJson(row.metadata),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      score: 1.0,
    };
  }

  async update(
    vectorId: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Update vector has ${vector.length} dimensions, expected ${this.dimensions}`,
      );
    }
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE ${this.tableMeta}
           SET user_id = ?, agent_id = ?, run_id = ?, hash = ?, data = ?,
               metadata = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(
          (payload.user_id as string) ?? null,
          (payload.agent_id as string) ?? null,
          (payload.run_id as string) ?? null,
          (payload.hash as string) ?? null,
          (payload.data as string) ?? null,
          JSON.stringify(payload.metadata ?? {}),
          vectorId,
        );

      // sqlite-vec doesn't support UPDATE on virtual tables —
      // delete + re-insert the vector row.
      this.db.prepare(`DELETE FROM ${this.tableVec} WHERE id = ?`).run(vectorId);
      this.db
        .prepare(`INSERT INTO ${this.tableVec} (id, embedding) VALUES (?, ?)`)
        .run(vectorId, new Float32Array(vector));
    });
    transaction();
  }

  async delete(vectorId: string): Promise<void> {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.tableMeta} WHERE id = ?`).run(vectorId);
      this.db.prepare(`DELETE FROM ${this.tableVec} WHERE id = ?`).run(vectorId);
    });
    transaction();
  }

  async list(
    filters?: SearchFilters,
    limit: number = 100,
  ): Promise<[VectorStoreResult[], number]> {
    let query = `SELECT id, user_id, agent_id, run_id, hash, data, metadata, created_at, updated_at FROM ${this.tableMeta}`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.userId) {
      conditions.push('user_id = ?');
      params.push(filters.userId);
    }
    if (filters?.agentId) {
      conditions.push('agent_id = ?');
      params.push(filters.agentId);
    }
    if (filters?.runId) {
      conditions.push('run_id = ?');
      params.push(filters.runId);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    // Get total count
    const countQuery = query.replace(
      /^SELECT .+ FROM/,
      'SELECT COUNT(*) as cnt FROM',
    );
    const countRow = this.db.prepare(countQuery).get(...params) as { cnt: number };
    const total = countRow?.cnt ?? 0;

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as MetaRow[];

    const results: VectorStoreResult[] = rows.map((row) => ({
      id: row.id,
      payload: {
        user_id: row.user_id,
        agent_id: row.agent_id,
        run_id: row.run_id,
        hash: row.hash,
        data: row.data,
        metadata: safeParseJson(row.metadata),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      score: 1.0,
    }));

    return [results, total];
  }

  async deleteCol(): Promise<void> {
    this.db.exec(`DROP TABLE IF EXISTS ${this.tableVec}`);
    this.db.exec(`DROP TABLE IF EXISTS ${this.tableMeta}`);
    await this.initialize();
  }

  close(): void {
    this.db.close();
  }
}

// ── Internal helpers ──────────────────────────────────────────────────

type MetaRow = {
  id: string;
  user_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  hash: string | null;
  data: string | null;
  metadata: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function safeParseJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
