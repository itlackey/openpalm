/**
 * HistoryManager interface — contract for audit-trail adapters.
 */
export interface HistoryManager {
  /** Log a memory mutation. */
  addHistory(
    memoryId: string,
    previousValue: string | null,
    newValue: string | null,
    action: string,
    createdAt?: string,
    updatedAt?: string,
    isDeleted?: number,
  ): Promise<void>;

  /** Get the mutation history for a specific memory. */
  getHistory(memoryId: string): Promise<HistoryEntry[]>;

  /** Delete all history records. */
  reset(): Promise<void>;

  /** Close the underlying database connection (if owned). */
  close(): void;
}

export type HistoryEntry = {
  id: number;
  memoryId: string;
  previousValue: string | null;
  newValue: string | null;
  action: string;
  createdAt: string;
  updatedAt: string;
  isDeleted: number;
};
