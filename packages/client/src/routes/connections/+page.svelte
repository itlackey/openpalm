<script lang="ts">
  // /connections — client-side connection manager (P5b item 3, #555),
  // adapted from packages/ui routes/connections onto the IndexedDB store
  // (plan §6.6). Everything happens in the browser: entries persist locally,
  // credentials live in the secret store under auth.secretRef, and health is
  // probed directly against each connection URL.
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import IconLock from '@openpalm/ui-kit/components/icons/IconLock.svelte';
  import { getClientBoot, type ClientBoot } from '$lib/boot.js';
  import { createTransport, type HealthProbeResult } from '$lib/transport/index.js';
  import type { ConnectionEntry } from '$lib/connections/index.js';

  type AuthMode = 'none' | 'basic' | 'bearer';

  let boot: ClientBoot | null = null;
  let connections = $state<ConnectionEntry[]>([]);
  let activeId = $state<string | null>(null);
  let health = $state<Record<string, HealthProbeResult>>({});
  let pageError = $state('');

  // ── Form state ─────────────────────────────────────────────────────────
  let formMode = $state<'idle' | 'add' | 'edit'>('idle');
  let formId = $state<string | null>(null);
  let formLabel = $state('');
  let formUrl = $state('');
  let formAuthMode = $state<AuthMode>('none');
  let formUsername = $state('');
  let formSecret = $state('');
  let formClearSecret = $state(false);
  let formSubmitting = $state(false);
  let formError = $state('');

  let deletingId = $state<string | null>(null);

  onMount(async () => {
    boot = await getClientBoot();
    await refresh();
    if (page.url.searchParams.get('new') === '1') openAddForm();
  });

  async function refresh(): Promise<void> {
    if (!boot) return;
    connections = await boot.store.list();
    activeId = await boot.store.getActiveId();
    void probeAll(connections);
  }

  async function probeAll(entries: ConnectionEntry[]): Promise<void> {
    if (!boot) return;
    const { secrets } = boot;
    const updates = await Promise.all(
      entries.map(async (entry) => {
        const transport = createTransport({
          baseUrl: entry.url,
          auth: await secrets.resolveAuth(entry),
        });
        return { id: entry.id, result: await transport.probeHealth() };
      })
    );
    health = Object.fromEntries(updates.map((u) => [u.id, u.result]));
  }

  function healthLabel(id: string): { text: string; tone: 'ok' | 'warn' | 'bad' | 'idle' } {
    const status = health[id];
    if (!status) return { text: 'checking…', tone: 'idle' };
    if (status.state === 'accessible') return { text: 'reachable', tone: 'ok' };
    if (status.state === 'unauthorized') return { text: 'auth failed', tone: 'warn' };
    return { text: 'unreachable', tone: 'bad' };
  }

  function openAddForm(): void {
    formMode = 'add';
    formId = null;
    formLabel = '';
    formUrl = '';
    formAuthMode = 'none';
    formUsername = '';
    formSecret = '';
    formClearSecret = false;
    formError = '';
  }

  function openEditForm(entry: ConnectionEntry): void {
    formMode = 'edit';
    formId = entry.id;
    formLabel = entry.label;
    formUrl = entry.url;
    formAuthMode = entry.auth.mode;
    formUsername = '';
    formSecret = '';
    formClearSecret = false;
    formError = '';
  }

  function cancelForm(): void {
    formMode = 'idle';
    formError = '';
  }

  /** Store new credential material (if any) and return the auth descriptor. */
  async function buildAuth(existing: ConnectionEntry | null): Promise<ConnectionEntry['auth']> {
    if (!boot) throw new Error('not booted');
    const previousRef = existing?.auth.secretRef;
    if (formAuthMode === 'none' || formClearSecret) {
      if (previousRef) await boot.secrets.delete(previousRef);
      return { mode: 'none' };
    }
    if (!formSecret) {
      // No new material entered: keep the existing secret if the mode
      // didn't change, otherwise the credential is required.
      if (existing && existing.auth.mode === formAuthMode && previousRef) {
        return existing.auth;
      }
      throw new Error(formAuthMode === 'basic' ? 'A password is required.' : 'A token is required.');
    }
    const ref = previousRef ?? crypto.randomUUID();
    await boot.secrets.set(
      ref,
      formAuthMode === 'basic'
        ? formUsername
          ? { username: formUsername, password: formSecret }
          : { password: formSecret }
        : { token: formSecret }
    );
    return { mode: formAuthMode, secretRef: ref };
  }

  async function submitForm(ev: Event): Promise<void> {
    ev.preventDefault();
    if (formSubmitting || !boot) return;
    const label = formLabel.trim();
    const url = formUrl.trim();
    if (!label || !url) {
      formError = 'Label and URL are required.';
      return;
    }

    formSubmitting = true;
    formError = '';
    try {
      if (formMode === 'add') {
        const auth = await buildAuth(null);
        await boot.store.add({ label, url, kind: 'remote-opencode', auth });
      } else if (formMode === 'edit' && formId) {
        const existing = await boot.store.get(formId);
        const auth = await buildAuth(existing);
        await boot.store.update(formId, { label, url, auth });
      }
      await refresh();
      formMode = 'idle';
    } catch (e) {
      formError = e instanceof Error ? e.message : 'Save failed.';
    } finally {
      formSubmitting = false;
    }
  }

  async function activate(id: string): Promise<void> {
    if (!boot) return;
    try {
      await boot.store.setActive(id);
      activeId = id;
    } catch (e) {
      pageError = e instanceof Error ? e.message : 'Could not activate the connection.';
    }
  }

  async function remove(entry: ConnectionEntry): Promise<void> {
    if (!boot || entry.locked) return;
    if (!confirm(`Remove connection "${entry.label}"?`)) return;
    deletingId = entry.id;
    try {
      if (entry.auth.secretRef) await boot.secrets.delete(entry.auth.secretRef);
      await boot.store.remove(entry.id);
      await refresh();
    } catch (e) {
      pageError = e instanceof Error ? e.message : 'Delete failed.';
    } finally {
      deletingId = null;
    }
  }
</script>

<svelte:head>
  <title>Connections — OpenPalm</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <h1>Connections</h1>
    <p class="lede">
      Connect to local or remote OpenPalm assistants. Entries marked
      <strong>Managed</strong> are provided by the server that hosts this app and cannot be
      edited here. Everything on this page is stored in this browser only.
    </p>
  </header>

  {#if pageError}
    <div class="alert error" role="alert">{pageError}</div>
  {/if}

  <section class="connections-list" aria-label="Configured connections">
    {#each connections as conn (conn.id)}
      <article class="connection-card" class:active={conn.id === activeId}>
        <div class="connection-main">
          <div class="connection-title">
            <span class="connection-label">{conn.label}</span>
            {#if conn.locked}<span class="badge default">Managed</span>{/if}
            {#if conn.isDefault}<span class="badge default">Default</span>{/if}
            {#if conn.id === activeId}<span class="badge active">Active</span>{/if}
            {#if conn.auth.mode !== 'none'}<span class="badge password" title="Credentials configured"><IconLock size={11} /></span>{/if}
            <span class="badge health {healthLabel(conn.id).tone}">{healthLabel(conn.id).text}</span>
          </div>
          <div class="connection-url">{conn.url}</div>
        </div>
        <div class="connection-actions">
          {#if conn.id !== activeId}
            <button type="button" class="btn btn-primary btn-sm" onclick={() => activate(conn.id)}>
              Use this
            </button>
          {/if}
          {#if !conn.locked}
            <button type="button" class="btn btn-secondary btn-sm" onclick={() => openEditForm(conn)}>
              Edit
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              onclick={() => remove(conn)}
              disabled={deletingId === conn.id}
            >
              {deletingId === conn.id ? 'Removing…' : 'Remove'}
            </button>
          {/if}
        </div>
      </article>
    {:else}
      <p class="empty">No connections yet — add one to start chatting.</p>
    {/each}
  </section>

  {#if formMode === 'idle'}
    <button type="button" class="btn btn-primary" onclick={openAddForm}>
      + Add connection
    </button>
  {:else}
    <form class="connection-form" onsubmit={submitForm}>
      <h2>{formMode === 'add' ? 'Add connection' : 'Edit connection'}</h2>

      <label class="field">
        <span>Label</span>
        <input
          type="text"
          bind:value={formLabel}
          placeholder="e.g. Home server"
          required
          autocomplete="off"
        />
      </label>

      <label class="field">
        <span>URL</span>
        <input
          type="url"
          bind:value={formUrl}
          placeholder="http://10.0.0.5:8443"
          required
          autocomplete="off"
        />
        <small>The base URL where the assistant (OpenCode or guardian) is reachable.</small>
      </label>

      <label class="field">
        <span>Authentication</span>
        <select bind:value={formAuthMode}>
          <option value="none">None</option>
          <option value="basic">Password (HTTP Basic)</option>
          <option value="bearer">Token (Bearer)</option>
        </select>
      </label>

      {#if formAuthMode === 'basic'}
        <label class="field">
          <span>Username (optional)</span>
          <input
            type="text"
            bind:value={formUsername}
            placeholder="openpalm"
            autocomplete="off"
          />
          <small>Defaults to <code>openpalm</code> — the username the OpenPalm stack provisions.</small>
        </label>
        <label class="field">
          <span>Password</span>
          <input
            type="password"
            bind:value={formSecret}
            placeholder={formMode === 'edit' ? 'Leave blank to keep current' : ''}
            autocomplete="new-password"
          />
          <small>Stored in this browser and sent only to this connection's URL.</small>
        </label>
      {:else if formAuthMode === 'bearer'}
        <label class="field">
          <span>Token</span>
          <input
            type="password"
            bind:value={formSecret}
            placeholder={formMode === 'edit' ? 'Leave blank to keep current' : ''}
            autocomplete="off"
          />
          <small>Stored in this browser and sent only to this connection's URL.</small>
        </label>
      {/if}

      {#if formMode === 'edit' && formAuthMode !== 'none'}
        <label class="field-inline">
          <input type="checkbox" bind:checked={formClearSecret} />
          <span>Clear stored credentials</span>
        </label>
      {/if}

      {#if formError}
        <div class="alert error" role="alert">{formError}</div>
      {/if}

      <div class="form-actions">
        <button type="submit" class="btn btn-primary" disabled={formSubmitting}>
          {formSubmitting ? 'Saving…' : 'Save'}
        </button>
        <button type="button" class="btn btn-secondary" onclick={cancelForm} disabled={formSubmitting}>
          Cancel
        </button>
      </div>
    </form>
  {/if}
</main>

<style>
  .page {
    max-width: 760px;
    margin: 0 auto;
    padding: var(--s-sp-6);
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-5);
  }
  .page-header h1 {
    margin: 0 0 var(--s-sp-2);
  }
  .lede {
    color: var(--s-ink-3);
    margin: 0;
  }

  .alert.error {
    padding: var(--s-sp-3);
    border-radius: 2px;
    background: color-mix(in srgb, var(--s-error) 8%, transparent);
    color: var(--s-error);
    border: 1px solid color-mix(in srgb, var(--s-error) 25%, transparent);
  }

  .connections-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
  }

  .empty {
    color: var(--s-ink-3);
  }

  .connection-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-sp-4);
    padding: var(--s-sp-4);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
  }
  .connection-card.active {
    border-color: var(--s-seal);
  }

  .connection-main {
    min-width: 0;
    flex: 1;
  }
  .connection-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-sp-2);
    font-weight: 500;
  }
  .connection-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .connection-url {
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    font-size: var(--s-type-deed);
    padding: 2px 8px;
    border-radius: 9999px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .badge.default {
    background: var(--s-paper-deep);
    color: var(--s-ink-3);
  }
  .badge.active {
    background: var(--s-seal);
    color: white;
  }
  .badge.password {
    background: transparent;
    color: var(--s-ink-3);
    padding: 0;
  }
  .badge.health.idle {
    background: var(--s-paper-deep);
    color: var(--s-ink-3);
  }
  .badge.health.ok {
    background: color-mix(in srgb, var(--s-moss) 18%, transparent);
    color: var(--s-moss);
  }
  .badge.health.warn {
    background: color-mix(in srgb, var(--s-seal) 14%, transparent);
    color: var(--s-seal);
  }
  .badge.health.bad {
    background: color-mix(in srgb, var(--s-error) 12%, transparent);
    color: var(--s-error);
  }

  .connection-actions {
    display: flex;
    gap: var(--s-sp-2);
    flex-shrink: 0;
  }

  .connection-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
    padding: var(--s-sp-5);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
  }
  .connection-form h2 {
    margin: 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
  }
  .field > span {
    font-size: var(--s-type-deed);
    font-weight: 500;
  }
  .field input,
  .field select {
    padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    font: inherit;
    background: var(--s-paper);
    color: var(--s-ink);
  }
  .field small {
    color: var(--s-ink-3);
    font-size: var(--s-type-deed);
  }
  .field code {
    font-family: var(--s-font-mono);
    background: var(--s-paper-deep);
    padding: 1px 4px;
    border-radius: 4px;
  }

  .field-inline {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
  }

  .form-actions {
    display: flex;
    gap: var(--s-sp-2);
  }
</style>
