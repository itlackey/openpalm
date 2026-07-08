/**
 * Per-connection credential material (plan ui-runtime-modes-plan.md §6.6,
 * §6.8): a ConnectionEntry carries only `auth.secretRef` — the actual
 * Basic/Bearer material lives here, in the same client-side storage backend
 * (IndexedDB in the browser), keyed by that ref. These are CONNECTION
 * credentials the user pasted for a guardian/OpenCode endpoint — never host
 * credentials (§8.10).
 */
import type { ConnectionAuth } from '../transport/index.js';
import type { ConnectionEntry, ConnectionStorage } from './index.js';

export type SecretMaterial = {
  username?: string;
  password?: string;
  token?: string;
};

export type SecretStore = {
  set(ref: string, material: SecretMaterial): Promise<void>;
  delete(ref: string): Promise<void>;
  /**
   * Build the transport auth for a connection. Missing or unreadable secret
   * material degrades to { mode: 'none' } — the health probe then reports
   * 'unauthorized' instead of the app crashing.
   */
  resolveAuth(entry: ConnectionEntry): Promise<ConnectionAuth>;
};

const META_PREFIX = 'secret:';

export function createSecretStore(storage: ConnectionStorage): SecretStore {
  return {
    async set(ref, material) {
      await storage.setMeta(META_PREFIX + ref, JSON.stringify(material));
    },

    async delete(ref) {
      await storage.setMeta(META_PREFIX + ref, null);
    },

    async resolveAuth(entry) {
      if (entry.auth.mode === 'none' || !entry.auth.secretRef) return { mode: 'none' };
      const raw = await storage.getMeta(META_PREFIX + entry.auth.secretRef);
      if (raw === null) return { mode: 'none' };
      let material: SecretMaterial;
      try {
        material = JSON.parse(raw) as SecretMaterial;
      } catch {
        return { mode: 'none' };
      }
      if (entry.auth.mode === 'basic' && typeof material.password === 'string') {
        return material.username
          ? { mode: 'basic', username: material.username, password: material.password }
          : { mode: 'basic', password: material.password };
      }
      if (entry.auth.mode === 'bearer' && typeof material.token === 'string') {
        return { mode: 'bearer', token: material.token };
      }
      return { mode: 'none' };
    },
  };
}
