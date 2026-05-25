<script lang="ts">
  import { onMount } from 'svelte';
  import Navbar from '$lib/components/Navbar.svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import {
    createEndpoint,
    updateEndpoint,
    deleteEndpoint,
    type AssistantEndpoint,
  } from '$lib/api.js';

  // ── Auth state ─────────────────────────────────────────────────────────
  let authLocked = $state(true);
  let authLoading = $state(false);
  let authError = $state('');

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

  const endpoints = $derived(endpointsService.endpoints);
  const active = $derived(endpointsService.active);

  async function handleAuthSuccess(token: string): Promise<boolean> {
    if (authLoading) return false;
    authLoading = true;
    authError = '';
    try {
      const res = await fetch('/admin/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'include',
      });
      if (!res.ok) {
        authError = 'Invalid admin token.';
        return false;
      }
      authLocked = false;
      await endpointsService.load(true);
      return true;
    } catch {
      authError = 'Unable to reach admin API.';
      return false;
    } finally {
      authLoading = false;
    }
  }

  onMount(() => {
    void (async () => {
      authLoading = true;
      try {
        const probe = await fetch('/admin/health', { credentials: 'include' });
        if (probe.status === 401 || probe.status === 503) {
          authLocked = true;
          return;
        }
        authLocked = false;
        await endpointsService.load(true);
      } catch {
        authError = 'Unable to reach admin API.';
      } finally {
        authLoading = false;
      }
    })();
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

  function openEditForm(e: AssistantEndpoint): void {
    formMode = 'edit';
    formId = e.id;
    formLabel = e.label;
    formUrl = e.url;
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
        await createEndpoint({
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
        await updateEndpoint(formId, patch);
      }
      await endpointsService.load(true);
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
      await endpointsService.activate(id);
    } catch {
      /* error surfaced via service */
    }
  }

  async function remove(e: AssistantEndpoint): Promise<void> {
    if (e.isDefault) return;
    if (!confirm(`Remove endpoint "${e.label}"?`)) return;
    deletingId = e.id;
    try {
      await deleteEndpoint(e.id);
      await endpointsService.load(true);
    } catch (err) {
      const e2 = err as { message?: string };
      endpointsService.error = e2.message ?? 'Delete failed.';
    } finally {
      deletingId = null;
    }
  }

</script>

<svelte:head>
  <title>Assistant Endpoints — OpenPalm</title>
</svelte:head>

{#if authLocked}
  <AuthGate onSuccess={handleAuthSuccess} loading={authLoading} error={authError} />
{:else}
  <Navbar navLink={{ href: '/chat', label: '← Back to Chat' }} />

  <main class="page">
    <header class="page-header">
      <h1>Assistant Endpoints</h1>
      <p class="lede">
        Connect to local or remote OpenPalm assistants. The <strong>Default</strong> entry comes
        from the environment (set by the launcher) and cannot be deleted. Add more endpoints to
        switch between stacks at any time.
      </p>
    </header>

    {#if endpointsService.error}
      <div class="alert error" role="alert">{endpointsService.error}</div>
    {/if}

    <section class="endpoints-list" aria-label="Configured endpoints">
      {#each endpoints as ep (ep.id)}
        <article class="endpoint-card" class:active={ep.id === active?.id}>
          <div class="endpoint-main">
            <div class="endpoint-title">
              <span class="endpoint-label">{ep.label}</span>
              {#if ep.isDefault}<span class="badge default">Default</span>{/if}
              {#if ep.id === active?.id}<span class="badge active">Active</span>{/if}
              {#if ep.hasPassword}<span class="badge password" title="Server password configured">🔒</span>{/if}
            </div>
            <div class="endpoint-url">{ep.url}</div>
          </div>
          <div class="endpoint-actions">
            {#if ep.id !== active?.id}
              <button type="button" class="btn btn-primary btn-sm" onclick={() => activate(ep.id)}>
                Use this
              </button>
            {/if}
            {#if !ep.isDefault}
              <button type="button" class="btn btn-secondary btn-sm" onclick={() => openEditForm(ep)}>
                Edit
              </button>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                onclick={() => remove(ep)}
                disabled={deletingId === ep.id}
              >
                {deletingId === ep.id ? 'Removing…' : 'Remove'}
              </button>
            {/if}
          </div>
        </article>
      {/each}
    </section>

    {#if formMode === 'idle'}
      <button type="button" class="btn btn-primary" onclick={openAddForm}>
        + Add endpoint
      </button>
    {:else}
      <form class="endpoint-form" onsubmit={submitForm}>
        <h2>{formMode === 'add' ? 'Add endpoint' : 'Edit endpoint'}</h2>

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
{/if}

<style>
  .page {
    max-width: 760px;
    margin: 0 auto;
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .page-header h1 {
    margin: 0 0 var(--space-2);
  }
  .lede {
    color: var(--color-text-muted);
    margin: 0;
  }

  .alert.error {
    padding: var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-danger-bg, #fee2e2);
    color: var(--color-danger-fg, #991b1b);
    border: 1px solid var(--color-danger-border, #fecaca);
  }

  .endpoints-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .endpoint-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg, #fff);
  }
  .endpoint-card.active {
    border-color: var(--color-accent, #2563eb);
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.08);
  }

  .endpoint-main {
    min-width: 0;
    flex: 1;
  }
  .endpoint-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 500;
  }
  .endpoint-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .endpoint-url {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    font-size: var(--text-xs);
    padding: 2px 8px;
    border-radius: var(--radius-full, 999px);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .badge.default {
    background: var(--color-bg-tertiary, #f3f4f6);
    color: var(--color-text-muted);
  }
  .badge.active {
    background: var(--color-accent, #2563eb);
    color: white;
  }
  .badge.password {
    background: transparent;
    color: var(--color-text-muted);
    padding: 0;
  }

  .endpoint-actions {
    display: flex;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .endpoint-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg, #fff);
  }
  .endpoint-form h2 {
    margin: 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .field > span {
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .field input {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font: inherit;
  }
  .field small {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
  }
  .field code {
    font-family: var(--font-mono);
    background: var(--color-bg-tertiary, #f3f4f6);
    padding: 1px 4px;
    border-radius: 4px;
  }
  .rotate-hint {
    margin-top: var(--space-2);
    padding: var(--space-3);
    border-left: 3px solid var(--color-accent, #2563eb);
    background: var(--color-bg-tertiary, #f3f4f6);
    color: var(--color-text);
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
  }
  .rotate-hint ol {
    margin: var(--space-2) 0 0;
    padding-left: var(--space-4);
  }
  .rotate-hint strong {
    display: block;
    margin-bottom: var(--space-1);
  }

  .field-inline {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .form-actions {
    display: flex;
    gap: var(--space-2);
  }

  .btn-danger {
    background: var(--color-danger-bg, #fee2e2);
    color: var(--color-danger-fg, #991b1b);
    border: 1px solid var(--color-danger-border, #fecaca);
  }
  .btn-danger:hover:not(:disabled) {
    background: var(--color-danger-bg-hover, #fecaca);
  }
</style>
