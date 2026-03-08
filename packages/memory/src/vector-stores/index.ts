/**
 * VectorStore factory — creates a VectorStore from provider config.
 */
export type { VectorStore } from './base.js';
import type { VectorStore } from './base.js';
import type { VectorStoreProviderConfig } from '../types.js';
import { SqliteVecStore } from './sqlite-vec.js';

export { SqliteVecStore } from './sqlite-vec.js';

export function createVectorStore(config: VectorStoreProviderConfig): VectorStore {
  switch (config.provider) {
    case 'sqlite-vec':
      return new SqliteVecStore(config.config);
    default:
      throw new Error(`Unsupported vector store provider: ${config.provider}`);
  }
}
