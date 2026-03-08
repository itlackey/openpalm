/**
 * Embedder interface — contract for embedding adapters.
 */
export interface Embedder {
  /** Embed a single text string into a vector. */
  embed(text: string): Promise<number[]>;
  /** Embed multiple texts in batch. */
  embedBatch(texts: string[]): Promise<number[][]>;
}
