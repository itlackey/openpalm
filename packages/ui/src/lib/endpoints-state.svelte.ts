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
 * Untangled from chat: this store NEVER imports chat
 * modules. Activation emits through $lib/connection-events; the chat store
 * subscribes (and registers its "not while sending" guard) from its own side.
 */
import { getConnectionStore, setActiveConnection } from './connections/boot.js';
import { loadRuntimeConfig, type Connection } from './connections/store.js';
import { discoverLocalAssistant } from './connections/discovery.js';
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

  /** The single in-flight load, shared by every concurrent caller. */
  private inFlight: Promise<void> | null = null;

  active = $derived<ConnectionView | null>(
    this.endpoints.find((e) => e.id === this.activeId) ?? this.endpoints[0] ?? null
  );

  /**
   * Load connections. Concurrent callers (multiple shell components mounting
   * together) share ONE request: instead of the second caller getting an
   * early `undefined` and having to busy-wait on the reactive flags, it
   * awaits the same in-flight promise. So `await endpointsService.load()`
   * always resolves only once connections are actually loaded (or errored).
   */
  async load(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.loaded && !force) return;
    const run = this._load();
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
    }
  }

  private async _load(): Promise<void> {
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
      if (!this.discoveryStarted) {
        this.discoveryStarted = true;
        // Fire-and-forget: the probe can take up to its timeout when nothing
        // is listening, and boot must not wait on it.
        void this.discoverLocal();
      }
    } catch (e) {
      const err = e as { message?: string; status?: number };
      this.error = err.message ?? 'Failed to load connections';
    } finally {
      this.loading = false;
    }
  }

  /** Localhost auto-discovery runs at most once per browsing session. */
  private discoveryStarted = false;

  /**
   * Probe the well-known local assistant endpoints and, when one is
   * reachable and not yet listed, add it and refresh the view. Best-effort:
   * failures are swallowed (discovery must never break boot).
   */
  private async discoverLocal(): Promise<void> {
    try {
      const store = getConnectionStore();
      const added = await discoverLocalAssistant(store);
      if (!added) return;
      const [connections, storedActiveId] = await Promise.all([
        store.list(),
        store.getActiveId(),
      ]);
      this.endpoints = connections.map(toView);
      this.activeId = storedActiveId ?? this.endpoints[0]?.id ?? '';
      setActiveConnection(connections.find((c) => c.id === this.activeId) ?? null);
      // When the discovered entry just became the effective active connection
      // (a previously empty list), complete the activation handoff so the
      // chat store loads its sessions instead of staying on "not reachable"
      // until a manual switch. Same veto guard as activate().
      if (this.activeId === added.id && !activationBlockReason()) {
        await emitConnectionActivated(added.id);
      }
    } catch {
      // best-effort only
    }
  }

  /** Monotonic activation counter: a failed activation may only roll state
   *  back if no NEWER activation has started since (otherwise a slow failure
   *  would clobber the selection a later, successful switch just persisted). */
  private activationSeq = 0;

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
    const seq = ++this.activationSeq;
    const previous = this.activeId;
    // Capture the previous connection NOW, from memory: on rollback it may
    // already be gone from the store (removed in another tab), and the store
    // round-trip is redundant when we already hold the object.
    const previousConnection = this.endpoints.find((e) => e.id === previous) ?? null;
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
      // Only the LATEST activation may roll back — a stale failure must not
      // overwrite state a newer activate() has since established.
      if (seq === this.activationSeq) {
        this.activeId = previous;
        if (previousConnection) {
          // setActive(id) above may have persisted the failed selection; roll
          // the PERSISTED id back too, or a reload would land on the
          // connection whose handoff just failed.
          await store.setActive(previous).catch(() => {});
          setActiveConnection(previousConnection);
        } else {
          // No usable previous ('' on first activation, or since-removed):
          // CLEAR the persisted selection — setActive('') would reject and
          // leave the failed id persisted, resurrecting it on reload.
          await store.clearActive().catch(() => {});
          setActiveConnection(null);
        }
      }
      const err = e as { message?: string };
      this.error = err.message ?? 'Failed to switch connection';
      throw e;
    }
  }
}

export const endpointsService = new ConnectionsService();
