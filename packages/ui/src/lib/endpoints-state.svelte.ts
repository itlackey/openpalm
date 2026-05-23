/**
 * Client-side store for the assistant endpoints list + active selection.
 *
 * Loaded lazily on first access. Other components ($lib/components/Navbar)
 * and pages (admin/endpoints) share this state so a change anywhere is
 * reflected everywhere without a full reload.
 */
import {
  fetchEndpoints,
  setActiveEndpoint,
  type AssistantEndpoint,
} from './api.js';
import { chat } from './chat/chat-state.svelte.js';

class EndpointsService {
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
        this.error = err.message ?? 'Failed to load endpoints';
      }
    } finally {
      this.loading = false;
    }
  }

  async activate(id: string): Promise<void> {
    if (id === this.activeId) return;
    // Mid-generation switches are blocked at the chat layer; surface the
    // refusal here so the switcher doesn't silently flip the activeId.
    if (chat.sending) {
      this.error = 'Wait for the current reply to finish before switching.';
      throw new Error(this.error);
    }
    const previous = this.activeId;
    this.activeId = id;
    try {
      await setActiveEndpoint(id);
      // Hand off to the per-endpoint chat state: load this endpoint's
      // sessions, restore the previously-open one (or the newest), and
      // fetch its messages. See docs/technical/multi-endpoint-session-ux.md.
      await chat.onEndpointChanged(id);
    } catch (e) {
      this.activeId = previous;
      const err = e as { message?: string };
      this.error = err.message ?? 'Failed to switch endpoint';
      throw e;
    }
  }
}

export const endpointsService = new EndpointsService();
