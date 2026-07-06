/**
 * Client-side store for the assistant connections list + active selection
 * (internal model renamed endpoint → connection in Phase 2 / #486; plan
 * ui-runtime-modes-plan.md §6.6).
 *
 * Loaded lazily on first access. Other components ($lib/components/Navbar)
 * and pages share this state so a change anywhere is reflected everywhere
 * without a full reload.
 *
 * NOTE on naming: the file name and the `endpointsService` export (and its
 * `endpoints`/`activeId` fields) are pinned by existing components and their
 * browser tests; they migrate with the Phase 5 client extraction. New code
 * is written in connection language.
 *
 * Untangled from chat (plan Phase 2 step 6): this store NEVER imports chat
 * modules. Activation emits through $lib/connection-events; the chat store
 * subscribes (and registers its "not while sending" guard) from its own side.
 */
import {
  fetchEndpoints,
  setActiveEndpoint,
  type AssistantEndpoint,
} from './api.js';
import { activationBlockReason, emitConnectionActivated } from './connection-events.js';

class ConnectionsService {
  endpoints = $state<AssistantEndpoint[]>([]);
  activeId = $state<string>('default');
  loading = $state(false);
  loaded = $state(false);
  error = $state('');

  active = $derived<AssistantEndpoint | null>(
    this.endpoints.find((e) => e.id === this.activeId) ?? this.endpoints[0] ?? null
  );

  async load(force = false): Promise<void> {
    if (this.loading) return;
    if (this.loaded && !force) return;
    this.loading = true;
    this.error = '';
    try {
      const { endpoints, activeId } = await fetchEndpoints();
      this.endpoints = endpoints;
      this.activeId = activeId;
      this.loaded = true;
    } catch (e) {
      const err = e as { message?: string; status?: number };
      // 401 is the auth gate's responsibility — don't surface here
      if (err.status !== 401) {
        this.error = err.message ?? 'Failed to load connections';
      }
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
    try {
      await setActiveEndpoint(id);
      // Hand off to subscribers (the chat store loads this connection's
      // sessions, restores the previously-open one, and fetches messages —
      // see docs/technical/multi-endpoint-session-ux.md). Awaited so a
      // failed handoff rolls the switch back.
      await emitConnectionActivated(id);
    } catch (e) {
      this.activeId = previous;
      const err = e as { message?: string };
      this.error = err.message ?? 'Failed to switch connection';
      throw e;
    }
  }
}

export const endpointsService = new ConnectionsService();
