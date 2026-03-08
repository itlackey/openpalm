/**
 * VectorStore interface — contract for vector store adapters.
 */
import type { SearchFilters, VectorStoreResult } from '../types.js';

export interface VectorStore {
  /** Initialize the store (create tables, load extensions, etc.). */
  initialize(): Promise<void>;

  /** Insert vectors with associated IDs and payloads. */
  insert(
    vectors: number[][],
    ids: string[],
    payloads: Record<string, unknown>[],
  ): Promise<void>;

  /** Search for the nearest vectors to the query. */
  search(
    query: number[],
    limit?: number,
    filters?: SearchFilters,
  ): Promise<VectorStoreResult[]>;

  /** Get a single vector entry by ID. */
  get(vectorId: string): Promise<VectorStoreResult | null>;

  /** Update a vector and its payload. */
  update(
    vectorId: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void>;

  /** Delete a vector entry by ID. */
  delete(vectorId: string): Promise<void>;

  /** List vector entries with optional filters. Returns [results, totalCount]. */
  list(
    filters?: SearchFilters,
    limit?: number,
  ): Promise<[VectorStoreResult[], number]>;

  /** Drop the entire collection and recreate it. */
  deleteCol(): Promise<void>;

  /** Close the underlying database connection. */
  close(): void;
}
