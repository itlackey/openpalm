<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import ChatNavbar from '$lib/components/chrome/ChatNavbar.svelte';
  import IconLock from '@openpalm/ui-kit/components/icons/IconLock.svelte';
  import { endpointsService as connectionsService } from '$lib/endpoints-state.svelte.js';
  import {
    createConnection,
    updateConnection,
    deleteConnection,
    type AssistantConnection,
  } from '$lib/api.js';

  // Capability-guarded surface (plan ui-runtime-modes-plan.md Phase 2, #486):
  // this page replaces /admin/endpoints and works in every mode that
  // advertises `connections:manage` — the API it talks to enforces the
  // capability server-side; auth is enforced in hooks.server.ts.

  // ── Form state ─────────────────────────────────────────────────────────
  let formMode = $state<'idle' | 'add' | 'edit'>('idle');
  let formId = $state<string | null>(null);
  let formLabel = $state('');
  let formUrl = $state('');
  let formPassword = $state('');
  let formClearPassword = $state(false);
  let formSubmitting = $state(false);
  let formError = $state('');

  // ── Per-row state ───────────────────────────────────────────────────────
  let deletingId = $state<string | null>(null);

  const connections = $derived(connectionsService.endpoints);
  const active = $derived(connectionsService.active);

  onMount(() => {
    void connectionsService.load(true);
    // The /connections/new landing (plan §6.5, Phase 3) aliases here with
    // ?new=1 — open the add form so "no connections yet" starts at the form.
    if (page.url.searchParams.get('new') === '1') openAddForm();
  });

  function openAddForm(): void {
    formMode = 'add';
    formId = null;
    formLabel = '';
    formUrl = '';
    formPassword = '';
    formClearPassword = false;
    formError = '';
  }

  function openEditForm(c: AssistantConnection): void {
    formMode = 'edit';
    formId = c.id;
    formLabel = c.label;
    formUrl = c.url;
    formPassword = '';
    formClearPassword = false;
    formError = '';
  }

  function cancelForm(): void {
    formMode = 'idle';
    formError = '';
  }

  async function submitForm(ev: Event): Promise<void> {
    ev.preventDefault();
    if (formSubmitting) return;
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
        await createConnection({
          label,
          url,
          ...(formPassword ? { password: formPassword } : {}),
        });
      } else if (formMode === 'edit' && formId) {
        const patch: { label: string; url: string; password?: string | null } = {
          label,
          url,
        };
        if (formClearPassword) {
          patch.password = null;
        } else if (formPassword) {
          patch.password = formPassword;
        }
        await updateConnection(formId, patch);
      }
      await connectionsService.load(true);
      formMode = 'idle';
    } catch (e) {
      const err = e as { message?: string };
      formError = err.message ?? 'Save failed.';
    } finally {
      formSubmitting = false;
    }
  }

  async function activate(id: string): Promise<void> {
    try {
      await connectionsService.activate(id);
    } catch {
      /* error surfaced via service */
    }
  }

  async function remove(c: AssistantConnection): Promise<void> {
    if (c.isDefault) return;
    if (!confirm(`Remove connection "${c.label}"?`)) return;
    deletingId = c.id;
    try {
      await deleteConnection(c.id);
      await connectionsService.load(true);
    } catch (err) {
      const e2 = err as { message?: string };
      connectionsService.error = e2.message ?? 'Delete failed.';
    } finally {
      deletingId = null;
    }
  }

</script>

<svelte:head>
  <title>Connections — OpenPalm</title>
</svelte:head>

<ChatNavbar />

<main class="page">
    <header class="page-header">
      <h1>Connections</h1>
      <p class="lede">
        Connect to local or remote OpenPalm assistants. The <strong>Default</strong> entry comes
        from the environment (set by the launcher) and cannot be deleted. Add more connections to
        switch between assistants at any time.
      </p>
    </header>

    {#if connectionsService.error}
      <div class="alert error" role="alert">{connectionsService.error}</div>
    {/if}

    <section class="connections-list" aria-label="Configured connections">
      {#each connections as conn (conn.id)}
        <article class="connection-card" class:active={conn.id === active?.id}>
          <div class="connection-main">
            <div class="connection-title">
              <span class="connection-label">{conn.label}</span>
              {#if conn.isDefault}<span class="badge default">Default</span>{/if}
              {#if conn.id === active?.id}<span class="badge active">Active</span>{/if}
              {#if conn.hasPassword}<span class="badge password" title="Server password configured"><IconLock size={11} /></span>{/if}
            </div>
            <div class="connection-url">{conn.url}</div>
          </div>
          <div class="connection-actions">
            {#if conn.id !== active?.id}
              <button type="button" class="btn btn-primary btn-sm" onclick={() => activate(conn.id)}>
                Use this
              </button>
            {/if}
            {#if !conn.isDefault}
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
            placeholder="http://10.0.0.5:3800"
            required
            autocomplete="off"
          />
          <small>The host:port where the remote OpenPalm assistant (OpenCode) is reachable.</small>
        </label>

        <label class="field">
          <span>Server password (optional)</span>
          <input
            type="password"
            bind:value={formPassword}
            placeholder={formMode === 'edit' ? 'Leave blank to keep current' : ''}
            autocomplete="new-password"
          />
          <small>
            Forwarded as HTTP Basic auth. Only required if the remote OpenCode was started with
            <code>OPENCODE_SERVER_PASSWORD</code>.
          </small>
          {#if formMode === 'edit'}
            <small class="rotate-hint">
              <strong>Rotating this password?</strong>
              OpenCode reads <code>OPENCODE_SERVER_PASSWORD</code> from its env at startup, so
              rotation is a two-step process:
              <ol>
                <li>
                  On the remote host: update <code>OP_OPENCODE_PASSWORD</code> in
                  <code>stack.env</code> and restart the <code>assistant</code> container.
                </li>
                <li>Paste the new value here and save.</li>
              </ol>
            </small>
          {/if}
        </label>

        {#if formMode === 'edit'}
          <label class="field-inline">
            <input type="checkbox" bind:checked={formClearPassword} />
            <span>Clear stored password</span>
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
    background: color-mix(in srgb, var(--s-seal) 8%, transparent);
    color: var(--s-seal);
    border: 1px solid color-mix(in srgb, var(--s-seal) 25%, transparent);
  }

  .connections-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
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
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.08);
  }

  .connection-main {
    min-width: 0;
    flex: 1;
  }
  .connection-title {
    display: flex;
    align-items: center;
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
  .field input {
    padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    font: inherit;
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
  .rotate-hint {
    margin-top: var(--s-sp-2);
    padding: var(--s-sp-3);
    border-left: 3px solid var(--s-seal);
    background: var(--s-paper-deep);
    color: var(--s-ink);
    border-radius: 0 2px 2px 0;
  }
  .rotate-hint ol {
    margin: var(--s-sp-2) 0 0;
    padding-left: var(--s-sp-4);
  }
  .rotate-hint strong {
    display: block;
    margin-bottom: var(--s-sp-1);
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

  .btn-danger {
    background: color-mix(in srgb, var(--s-seal) 8%, transparent);
    color: var(--s-seal);
    border: 1px solid color-mix(in srgb, var(--s-seal) 25%, transparent);
  }
  .btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--s-seal) 14%, transparent);
  }
</style>
