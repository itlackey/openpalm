/**
 * Reactive connection list + active selection for the switcher and pages.
 *
 * Phase 3b ("One UI, delete the split"): backed by the browser-owned
 * connection store (`$lib/connections/boot`), not the deleted host
 * `/api/connections` surface. The store persists in IndexedDB; this class is
 * the shared reactive view over it so a change anywhere (switcher, /connections
 * page) is reflected everywhere without a reload.
 *
 * Seeds locked/default entries from `loadRuntimeConfig()` once on first load.
 * Keeps the transport's active-connection snapshot in sync via
 * `setActiveConnection()` — a plain call, no `$effect`.
 *
 * NOTE on naming: the file name and the `endpointsService` export (and its
 * `endpoints`/`activeId` fields) are pinned by existing components and their
 * browser tests, so they are preserved. New code is written in connection
 * language.
 *
 * Untangled from chat (plan Phase 2 step 6): this store NEVER imports chat
 * modules. Activation emits through $lib/connection-events; the chat store
 * subscribes (and registers its "not while sending" guard) from its own side.
 */
import { getConnectionStore, setActiveConnection } from './connections/boot.js';
import { loadRuntimeConfig, type Connection } from './connections/store.js';
import { activationBlockReason, emitConnectionActivated } from './connection-events.js';

/**
 * The connection shape existing consumers (switcher, ActivityTab, /connections)
 * read. A superset of the stored `Connection` that preserves the historical
 * `url` / `isDefault` / `hasPassword` fields:
 *   - `url`        — alias of `baseUrl`
 *   - `isDefault`  — config-owned (locked) or seeded default → not removable
 *   - `hasPassword`— Basic credentials attached
 */
export type ConnectionView = Connection & {
  url: string;
  isDefault: boolean;
  hasPassword: boolean;
};

function toView(c: Connection): ConnectionView {
  return {
    ...c,
    url: c.baseUrl,
    isDefault: Boolean(c.isDefault || c.locked),
    hasPassword: c.auth.mode === 'basic',
  };
}

class ConnectionsService {
  endpoints = $state<ConnectionView[]>([]);
  activeId = $state<string>('');
  loading = $state(false);
  loaded = $state(false);
  error = $state('');

  /** Runtime-config seed runs exactly once per browsing session. */
  private seeded = false;

  active = $derived<ConnectionView | null>(
    this.endpoints.find((e) => e.id === this.activeId) ?? this.endpoints[0] ?? null
  );

  async load(force = false): Promise<void> {
    if (this.loading) return;
    if (this.loaded && !force) return;
    this.loading = true;
    this.error = '';
    try {
      const store = getConnectionStore();
      if (!this.seeded) {
        this.seeded = true;
        await store.seedFromRuntimeConfig(await loadRuntimeConfig());
      }
      const [connections, storedActiveId] = await Promise.all([
        store.list(),
        store.getActiveId(),
      ]);
      this.endpoints = connections.map(toView);
      this.activeId = storedActiveId ?? this.endpoints[0]?.id ?? '';
      // Keep the transport's active connection in sync (no $effect).
      setActiveConnection(connections.find((c) => c.id === this.activeId) ?? null);
      this.loaded = true;
    } catch (e) {
      const err = e as { message?: string; status?: number };
      this.error = err.message ?? 'Failed to load connections';
    } finally {
      this.loading = false;
    }
  }

  async activate(id: string): Promise<void> {
    if (id === this.activeId) return;
    // A subscriber may veto the switch (the chat side blocks mid-generation
    // switches); surface the refusal here so the switcher doesn't silently
    // flip the activeId.
    const blocked = activationBlockReason();
    if (blocked) {
      this.error = blocked;
      throw new Error(blocked);
    }
    const previous = this.activeId;
    this.activeId = id;
    const store = getConnectionStore();
    try {
      await store.setActive(id);
      setActiveConnection((await store.get(id)) ?? null);
      // Hand off to subscribers (the chat store loads this connection's
      // sessions, restores the previously-open one, and fetches messages —
      // see docs/technical/multi-endpoint-session-ux.md). Awaited so a
      // failed handoff rolls the switch back.
      await emitConnectionActivated(id);
    } catch (e) {
      this.activeId = previous;
      setActiveConnection((await store.get(previous).catch(() => null)) ?? null);
      const err = e as { message?: string };
      this.error = err.message ?? 'Failed to switch connection';
      throw e;
    }
  }
}

export const endpointsService = new ConnectionsService();
