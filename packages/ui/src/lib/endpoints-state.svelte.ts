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
import {
  loadRuntimeConfig,
  type Connection,
  type ConnectionStore,
} from './connections/store.js';
import { discoverLocalAssistant } from './connections/discovery.js';
import {
  activationBlockReason,
  beginConnectionActivation,
  emitConnectionActivated,
} from './connection-events.js';

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

	/** One forced refresh may trail each currently running load. */
  private trailingForce: Promise<void> | null = null;

  /** Serialize IndexedDB active-id writes in activation request order. */
  private activeWrites: Promise<void> = Promise.resolve();

  /** Last connection published to memory, transport, and activation listeners. */
  private publishedActiveId = '';
  private publishedConnection: Connection | null = null;
	private pendingActivation: {
		id: string;
		expectedActiveId: string | undefined;
		promise: Promise<void>;
	} | null = null;

  private async restoreActiveId(
    store: ConnectionStore,
    connections: Connection[],
    storedActiveId: string | null
  ): Promise<string | null> {
    const activeExists = connections.some((connection) => connection.id === storedActiveId);
    const restoredActiveId = activeExists ? storedActiveId : (connections[0]?.id ?? null);
    if (restoredActiveId !== storedActiveId) {
      await this.queueActiveWrite(() =>
        restoredActiveId ? store.setActive(restoredActiveId) : store.clearActive()
      );
    }
    return restoredActiveId;
  }

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
  load(force = false): Promise<void> {
    if (this.inFlight) {
      if (!force) return this.inFlight;
      if (!this.trailingForce) {
        const current = this.inFlight;
        const trailing = current
          .then(() => {
            if (this.trailingForce === trailing) this.trailingForce = null;
            return this.startLoad();
          })
          .finally(() => {
            if (this.trailingForce === trailing) this.trailingForce = null;
          });
        this.trailingForce = trailing;
      }
      return this.trailingForce;
    }
    if (this.loaded && !force) return Promise.resolve();
    return this.startLoad();
  }

  private startLoad(): Promise<void> {
    const run = this._load().finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async _load(): Promise<void> {
    const activationSeq = this.activationSeq;
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
      if (activationSeq !== this.activationSeq) return;
      // Refreshing the endpoint list, marking loaded, and kicking discovery are
      // always safe under a concurrent activation and must run unconditionally
      // so a reload still surfaces added/removed connections.
      this.endpoints = connections.map(toView);
      this.loaded = true;
      if (!this.discoveryStarted) {
        this.discoveryStarted = true;
        // Fire-and-forget: the probe can take up to its timeout when nothing
        // is listening, and boot must not wait on it. The settled promise is
        // kept so localDiscoverySettled() callers CAN wait when they need
        // the final "no connections at all" verdict (discoverLocal never
        // rejects — failures are swallowed inside it).
        this.discoverySettled = this.discoverLocal();
      }
      // #576: an in-flight activation is the sole authority on the active
      // selection. The activationSeq guard above only catches an activation
      // that bumped the seq DURING this load; an activation already in flight
      // when we captured the seq performed its single bump earlier, so the seq
      // is unchanged and both seq checks pass. pendingActivation — set the
      // instant an activation starts — is the signal the seq guard is blind to.
      // Gating BEFORE restoreActiveId also suppresses its self-heal store write,
      // which would otherwise race the activation's own write on the shared
      // activeWrites queue.
      if (this.pendingActivation) return;
      const restoredActiveId = await this.restoreActiveId(store, connections, storedActiveId);
      if (activationSeq !== this.activationSeq) return;
      // Re-check immediately before the synchronous publish, with NO await
      // between this gate and the writes, so an activation that started during
      // the restoreActiveId await above still wins.
      if (this.pendingActivation) return;
      this.activeId = restoredActiveId ?? '';
      // Keep the transport's active connection in sync (no $effect).
      const activeConnection = connections.find((c) => c.id === this.activeId) ?? null;
      setActiveConnection(activeConnection);
      this.publishedActiveId = this.activeId;
      this.publishedConnection = activeConnection;
    } catch (e) {
      const err = e as { message?: string; status?: number };
      this.error = err.message ?? 'Failed to load connections';
    } finally {
      this.loading = false;
    }
  }

  /** Localhost auto-discovery runs at most once per browsing session. */
  private discoveryStarted = false;

  /** The once-per-session discovery run, kept for localDiscoverySettled(). */
  private discoverySettled: Promise<void> | null = null;

  /**
   * Settles when the once-per-session local discovery has finished; resolves
   * immediately when it never started (or load() hasn't run). Lets the chat
   * landing (PR #571 review P2, #511) declare "no connections at all" only
   * after discovery had its chance to add a reachable local assistant.
   */
  async localDiscoverySettled(): Promise<void> {
    await this.discoverySettled;
  }

  /**
   * Probe the well-known local assistant endpoints and, when one is
   * reachable and not yet listed, add it and refresh the view. Best-effort:
   * failures are swallowed (discovery must never break boot).
   */
  private async discoverLocal(): Promise<void> {
    try {
      const activationSeq = this.activationSeq;
      const store = getConnectionStore();
      const added = await discoverLocalAssistant(store);
      if (!added) return;
      const [connections, storedActiveId] = await Promise.all([
        store.list(),
        store.getActiveId(),
      ]);
      // Always refresh the endpoint list — a newly discovered connection must
      // surface even when a concurrent activation owns the active selection.
      this.endpoints = connections.map(toView);
      if (activationSeq !== this.activationSeq) return;
      // #576: same reasoning as _load — an in-flight activation is the sole
      // authority on the active selection, and pendingActivation catches the
      // already-in-flight case the seq guard cannot. Gating before
      // restoreActiveId also suppresses its self-heal store write.
      if (this.pendingActivation) return;
      const restoredActiveId = await this.restoreActiveId(store, connections, storedActiveId);
      if (activationSeq !== this.activationSeq) return;
      if (this.pendingActivation) return;
      this.activeId = restoredActiveId ?? '';
      const activeConnection = connections.find((c) => c.id === this.activeId) ?? null;
      setActiveConnection(activeConnection);
      // When the discovered entry just became the effective active connection
      // (a previously empty list), complete the activation handoff so the
      // chat store loads its sessions instead of staying on "not reachable"
      // until a manual switch. Same veto guard as activate().
      if (this.activeId === added.id && !activationBlockReason()) {
        await emitConnectionActivated(added.id);
        // The handoff await split the active-state sequence: re-check both
        // guards before the trailing publish so an activation that started
        // during the emit still wins.
        if (activationSeq !== this.activationSeq) return;
        if (this.pendingActivation) return;
      }
      this.publishedActiveId = this.activeId;
      this.publishedConnection = activeConnection;
    } catch {
      // best-effort only
    }
  }

  /** Monotonic activation counter: a failed activation may only roll state
   *  back if no NEWER activation has started since (otherwise a slow failure
   *  would clobber the selection a later, successful switch just persisted). */
  private activationSeq = 0;

	private queueActiveWrite<T>(write: () => Promise<T>): Promise<T> {
    const queued = this.activeWrites.then(write, write);
		this.activeWrites = queued.then(
			() => {},
			() => {}
		);
    return queued;
  }

	activate(id: string, expectedActiveId?: string): Promise<void> {
		if (
			this.pendingActivation?.id === id &&
			this.pendingActivation.expectedActiveId === expectedActiveId
		) {
			return this.pendingActivation.promise;
		}
		if (
			id === this.publishedActiveId &&
			expectedActiveId === undefined &&
			!this.pendingActivation
		) {
			return Promise.resolve();
		}
    // A subscriber may veto the switch (the chat side blocks mid-generation
    // switches); surface the refusal here so the switcher doesn't silently
    // flip the activeId.
    const blocked = activationBlockReason();
    if (blocked) {
      this.error = blocked;
			return Promise.reject(new Error(blocked));
    }
		const releaseActivation = beginConnectionActivation();
		const promise = this.activateConnection(id, expectedActiveId).finally(releaseActivation);
		const pending = { id, expectedActiveId, promise };
		this.pendingActivation = pending;
		void promise.then(
			() => {
				if (this.pendingActivation === pending) this.pendingActivation = null;
			},
			() => {
				if (this.pendingActivation === pending) this.pendingActivation = null;
			}
		);
		return promise;
	}

	private async adoptPersistedActive(seq: number, store: ConnectionStore): Promise<void> {
		const persistedActiveId = await store.getActiveId();
		if (seq !== this.activationSeq) return;
		const connection = persistedActiveId ? await store.get(persistedActiveId) : null;
		if (seq !== this.activationSeq) return;
		this.activeId = connection?.id ?? '';
		setActiveConnection(connection);
		if (connection) {
			await emitConnectionActivated(connection.id);
			if (seq !== this.activationSeq) return;
		}
		this.publishedActiveId = connection?.id ?? '';
		this.publishedConnection = connection;
	}

	private async activateConnection(id: string, expectedActiveId?: string): Promise<void> {
    const seq = ++this.activationSeq;
    this.error = '';
    this.activeId = id;
    const store = getConnectionStore();
		let activeChanged = false;
    try {
			activeChanged = await this.queueActiveWrite(async () => {
				if (expectedActiveId !== undefined) {
					return store.compareAndSetActive(expectedActiveId, id);
				}
				await store.setActive(id);
				return true;
			});
      if (seq !== this.activationSeq) return;
			if (!activeChanged) {
				await this.adoptPersistedActive(seq, store);
				return;
			}
      const connection = await store.get(id);
      if (seq !== this.activationSeq) return;
      if (!connection) throw new Error(`Unknown connection: ${id}`);
      setActiveConnection(connection);
      // Hand off to subscribers (the chat store loads this connection's
      // sessions, restores the previously-open one, and fetches messages —
      // see docs/technical/multi-endpoint-session-ux.md). Awaited so a
      // failed handoff rolls the switch back.
      await emitConnectionActivated(id);
      if (seq !== this.activationSeq) return;
      this.publishedActiveId = id;
      this.publishedConnection = connection;
    } catch (e) {
      // Only the LATEST activation may roll back — a stale failure must not
      // overwrite state a newer activate() has since established.
			if (seq === this.activationSeq && activeChanged) {
        const rollbackId = this.publishedActiveId;
        const rollbackConnection = this.publishedConnection;
				const rolledBack = await this.queueActiveWrite(() =>
					store.compareAndSetActive(id, rollbackConnection && rollbackId ? rollbackId : null)
				).catch(() => false);
        if (seq !== this.activationSeq) throw e;
				if (rolledBack) {
					this.activeId = rollbackId;
					setActiveConnection(rollbackConnection);
					if (rollbackId) await emitConnectionActivated(rollbackId).catch(() => {});
				} else {
					await this.adoptPersistedActive(seq, store);
				}
			} else if (seq === this.activationSeq) {
				this.activeId = this.publishedActiveId;
				setActiveConnection(this.publishedConnection);
      }
      if (seq === this.activationSeq) {
        const err = e as { message?: string };
        this.error = err.message ?? 'Failed to switch connection';
      }
      throw e;
    }
  }
}

export const endpointsService = new ConnectionsService();
