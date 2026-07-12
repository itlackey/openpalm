<script lang="ts">
  // /connections — client-side connection manager (P5b item 3, #555),
  // adapted from packages/ui routes/connections onto the IndexedDB store
  // (plan §6.6). Everything happens in the browser: entries persist locally,
  // credentials live in the secret store under auth.secretRef, and health is
  // probed directly against each connection URL.
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import IconLock from '@openpalm/ui-kit/components/icons/IconLock.svelte';
  import Drawer from '@openpalm/ui-kit/components/common/Drawer.svelte';
  import { getClientBoot, type ClientBoot } from '$lib/boot.js';
  import { createTransport, type HealthProbeResult } from '$lib/transport/index.js';
  import type { ConnectionEntry } from '$lib/connections/index.js';
  import { validateConnectionUrl, TLS_GUIDE_URL } from '$lib/connections/url-policy.js';

  type AuthMode = 'none' | 'basic' | 'bearer';

  let boot: ClientBoot | null = null;
  let connections = $state<ConnectionEntry[]>([]);
  let activeId = $state<string | null>(null);
  let health = $state<Record<string, HealthProbeResult>>({});
  let pageError = $state('');

  // ── Form state ─────────────────────────────────────────────────────────
  // 'credentials' (E6, review 2026-07-10 §E6) is a fourth mode alongside
  // add/edit: it opens the SAME form for a locked entry, but the
  // label/url fields are read-only context and submitForm() routes to
  // store.setSecretRef() instead of the locked-rejecting store.update() —
  // identity stays config-owned, only auth may change.
  let formMode = $state<'idle' | 'add' | 'edit' | 'credentials'>('idle');
  let formId = $state<string | null>(null);
  let formLabel = $state('');
  let formUrl = $state('');
  let formAuthMode = $state<AuthMode>('none');
  let formUsername = $state('');
  let formSecret = $state('');
  let formClearSecret = $state(false);
  let formSubmitting = $state(false);
  let formError = $state('');
  // #557 D1: set only for an 'insecure-remote' refusal, so the error alert
  // can deep-link the TLS guide; cleared everywhere formError is reset.
  let formErrorGuideUrl = $state<string | null>(null);

  const formTitle = $derived(
    formMode === 'add' ? 'Add connection' : formMode === 'credentials' ? 'Set credentials' : 'Edit connection'
  );

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
    // E3 (UI half, review 2026-07-10 §E3): a CORS-denied fetch and a
    // genuinely down connection both used to render bare "unreachable" —
    // transport.probeHealth() disambiguates them (transport-health-cors
    // .test.ts), so surface that as its own state with remediation, instead
    // of collapsing it back into the same dead end.
    if (status.state === 'blocked' && status.detail === 'cors') {
      return { text: 'blocked (CORS)', tone: 'warn' };
    }
    // #557 D6: a plain-http remote target on this app's https origin is
    // refused by the browser's mixed-content blocker before any request is
    // even attempted — distinct badge text from "unreachable" so the fix
    // (use HTTPS) is obvious rather than looking like a dead server.
    if (status.state === 'insecure') {
      return { text: 'needs HTTPS', tone: 'warn' };
    }
    return { text: 'unreachable', tone: 'bad' };
  }

  /**
   * E3/I4: remediation copy for a CORS-blocked probe, naming the two knobs
   * that actually fix it — GUARDIAN_CORS_ALLOWED_ORIGINS (the allowlist
   * itself) and GUARDIAN_DIRECT_INGRESS (which must be enabled for a
   * guardian-fronted connection to answer direct browser requests at all;
   * review §I4). null when the connection isn't in the blocked/cors state.
   */
  function healthRemediation(id: string): string | null {
    const status = health[id];
    if (status?.state !== 'blocked' || status.detail !== 'cors') return null;
    return (
      'The server refused this cross-origin request. Add this app’s origin to ' +
      'GUARDIAN_CORS_ALLOWED_ORIGINS on the connection’s server, and make sure ' +
      'GUARDIAN_DIRECT_INGRESS is enabled if this is a guardian-fronted connection.'
    );
  }

  /**
   * #557 D6/D7: remediation for the 'insecure' probe state — this app runs
   * on a secure (https) origin, so browsers block plain-HTTP connections to
   * remote servers (mixed content). null when the connection isn't in that
   * state.
   */
  function isInsecure(id: string): boolean {
    return health[id]?.state === 'insecure';
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
    formErrorGuideUrl = null;
  }

  /**
   * E9 (review 2026-07-10 §E9): loads the stored Basic username via
   * secrets.peekUsername() — never the password/token — so a custom
   * username survives round-tripping through the edit form instead of
   * silently reverting to the 'openpalm' default whenever the password
   * isn't retyped.
   */
  async function loadStoredUsername(entry: ConnectionEntry): Promise<string> {
    if (!boot || entry.auth.mode !== 'basic' || !entry.auth.secretRef) return '';
    return (await boot.secrets.peekUsername(entry.auth.secretRef)) ?? '';
  }

  /**
   * S3 (review of PR #562): openEditForm() and "Set credentials" used to be
   * two byte-identical functions differing only in which formMode they set
   * — collapsed into one helper. E6 (review 2026-07-10 §E6): 'credentials'
   * opens the SAME form for a locked entry, but submitForm() routes THAT
   * mode to store.setSecretRef() (bypasses only the locked check, and only
   * for auth) rather than store.update(), so a locked entry's url/label/kind
   * stay immutable even though the form technically holds copies of them
   * (for display + so the shared submit validation still passes).
   */
  async function openEntryForm(entry: ConnectionEntry, mode: 'edit' | 'credentials'): Promise<void> {
    formMode = mode;
    formId = entry.id;
    formLabel = entry.label;
    formUrl = entry.url;
    formAuthMode = entry.auth.mode;
    formSecret = '';
    formClearSecret = false;
    formError = '';
    formErrorGuideUrl = null;
    formUsername = await loadStoredUsername(entry);
  }

  function cancelForm(): void {
    formMode = 'idle';
    formError = '';
    formErrorGuideUrl = null;
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
        // E9: the password wasn't retyped, but the username field is still
        // live-edited (it was preloaded via peekUsername) — apply it
        // without touching the stored password, instead of silently
        // discarding the change (the E9 bug: this branch used to return
        // `existing.auth` verbatim).
        if (formAuthMode === 'basic') {
          await boot.secrets.updateUsername(previousRef, formUsername || undefined);
        }
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
      formErrorGuideUrl = null;
      return;
    }

    // #557 D1: the URL field is validated in add/edit modes only —
    // 'credentials' mode never submits a URL, identity is config-owned
    // there (see the read-only context block above).
    if (formMode === 'add' || formMode === 'edit') {
      const verdict = validateConnectionUrl(url);
      if (!verdict.ok) {
        formError = verdict.message;
        formErrorGuideUrl = verdict.reason === 'insecure-remote' ? verdict.guideUrl : null;
        return;
      }
    }

    formSubmitting = true;
    formError = '';
    formErrorGuideUrl = null;
    try {
      if (formMode === 'add') {
        const auth = await buildAuth(null);
        await boot.store.add({ label, url, kind: 'remote-opencode', auth });
      } else if (formMode === 'edit' && formId) {
        const existing = await boot.store.get(formId);
        const auth = await buildAuth(existing);
        await boot.store.update(formId, { label, url, auth });
      } else if (formMode === 'credentials' && formId) {
        // E6: locked entries route through setSecretRef, never update() —
        // label/url are read-only context in this mode and are never sent.
        const existing = await boot.store.get(formId);
        const auth = await buildAuth(existing);
        await boot.store.setSecretRef(formId, auth);
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
            {#if conn.auth.mode !== 'none'}
              <!-- G4 (review 2026-07-10 §G4): an icon-only span with only a
                   hover title is invisible to screen readers — role="img" +
                   aria-label gives it an accessible name independent of
                   hover/title support. -->
              <span class="badge password" role="img" aria-label="Credentials configured" title="Credentials configured">
                <IconLock size={11} />
              </span>
            {/if}
            <span class="badge health {healthLabel(conn.id).tone}">{healthLabel(conn.id).text}</span>
          </div>
          <div class="connection-url">{conn.url}</div>
          {#if healthRemediation(conn.id)}
            <p class="remediation">{healthRemediation(conn.id)}</p>
          {/if}
          {#if isInsecure(conn.id)}
            <p class="remediation">
              This app runs on a secure (https) origin, so browsers block plain-HTTP connections
              to remote servers. <a href={TLS_GUIDE_URL} target="_blank" rel="noopener noreferrer"
                >Set up HTTPS for remote access</a
              >.
            </p>
          {/if}
        </div>
        <div class="connection-actions">
          {#if conn.id !== activeId}
            <button type="button" class="btn btn-primary btn-sm" onclick={() => activate(conn.id)}>
              Use this
            </button>
          {/if}
          {#if conn.locked}
            <!-- E6 (review 2026-07-10 §E6): locked entries can't be edited,
                 but they CAN receive credentials — a config-owned default
                 assistant URL that requires auth previously had no UI path
                 to supply it and permanently 401s. -->
            <button type="button" class="btn btn-secondary btn-sm" onclick={() => openEntryForm(conn, 'credentials')}>
              Set credentials
            </button>
          {:else}
            <button type="button" class="btn btn-secondary btn-sm" onclick={() => openEntryForm(conn, 'edit')}>
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

  <!-- G2/G3 (review 2026-07-10): stays mounted while the drawer is open
       rather than `{#if formMode === 'idle'}`-gated (and NOT `disabled` —
       a `disabled` attribute takes a focused button out of the focus order
       synchronously too). The ui-kit Drawer's focus-trap (G3) restores
       focus to whatever `document.activeElement` WAS at open time, by
       object reference — hiding or disabling this button when the drawer
       opens invalidated that reference (a removed/disabled node can't be
       refocused), so `.focus()` on close silently no-op'd to `<body>`
       (caught by the G2 Playwright suite's Escape/Cancel focus-restore
       assertions). Harmless to leave live: the Drawer's full-viewport
       `.drawer-scrim` sits above it in the stacking order and intercepts
       any click while open. -->
  <button type="button" class="btn btn-primary" onclick={openAddForm}>
    + Add connection
  </button>

  <!-- G3 (review 2026-07-10 §G3): the add/edit/credentials form used to be
       an inline expand-in-place block with no focus management at all —
       focus dropped to <body> on open/cancel/save, no Escape, no trap. The
       ui-kit Drawer (G3's promoted focus-trap, reused from the chat page's
       sessions drawer) focuses the first field on open, restores focus to
       the button that opened it on cancel/save, and closes on Escape. -->
  <Drawer open={formMode !== 'idle'} title={formTitle} onClose={cancelForm}>
    <form id="connection-form" onsubmit={submitForm}>
      {#if formMode === 'credentials'}
        <!-- E6: identity is read-only context here — submitForm() routes
             this mode to store.setSecretRef(), which never touches
             url/label/kind, so there is deliberately no editable url/label
             input in this branch (not just a disabled one). -->
        <p class="credentials-context">
          Setting credentials for <strong>{formLabel}</strong> (<code>{formUrl}</code>). This
          connection's URL is managed by the server that hosts this app and can't be changed here.
        </p>
      {:else}
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
          placeholder="https://home-server.tailnet.ts.net"
          required
          autocomplete="off"
        />
        <small>The base URL where the assistant (OpenCode or guardian) is reachable.</small>
      </label>
      {/if}

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
            placeholder={formMode !== 'add' ? 'Leave blank to keep current' : ''}
            autocomplete="new-password"
          />
          <!-- E7 (review 2026-07-10 §E7): document the residual exposure —
               encrypting at rest stops casual "read the IndexedDB" access,
               but any script that runs on this page can still ask the
               secret store to use the credential (the trust boundary is
               this browser tab/origin, not this device). -->
          <small>
            Encrypted at rest in this browser; still usable by any script that runs on this page.
            Sent only to this connection's URL.
          </small>
        </label>
      {:else if formAuthMode === 'bearer'}
        <label class="field">
          <span>Token</span>
          <input
            type="password"
            bind:value={formSecret}
            placeholder={formMode !== 'add' ? 'Leave blank to keep current' : ''}
            autocomplete="off"
          />
          <small>
            Encrypted at rest in this browser; still usable by any script that runs on this page.
            Sent only to this connection's URL.
          </small>
        </label>
      {/if}

      {#if formMode !== 'add' && formAuthMode !== 'none'}
        <label class="field-inline">
          <input type="checkbox" bind:checked={formClearSecret} />
          <span>Clear stored credentials</span>
        </label>
      {/if}

      {#if formError}
        <div class="alert error" role="alert">
          {formError}
          {#if formErrorGuideUrl}
            <a href={formErrorGuideUrl} target="_blank" rel="noopener noreferrer"
              >Set up HTTPS for remote access</a
            >
          {/if}
        </div>
      {/if}
    </form>

    {#snippet footer()}
      <button type="submit" form="connection-form" class="btn btn-primary" disabled={formSubmitting}>
        {formSubmitting ? 'Saving…' : 'Save'}
      </button>
      <button type="button" class="btn btn-secondary" onclick={cancelForm} disabled={formSubmitting}>
        Cancel
      </button>
    {/snippet}
  </Drawer>
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
    align-items: flex-start;
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
  /* E3/I4 (review 2026-07-10): remediation text for a CORS-blocked probe —
     unlike .connection-url this wraps; it names two env vars and needs to
     stay legible. */
  .remediation {
    color: var(--s-seal);
    font-size: var(--s-type-deed);
    margin: var(--s-sp-1) 0 0;
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

  /* The form now lives in the ui-kit Drawer (G3) — its body already
     supplies padding/scroll, so the form itself is just a field stack. */
  #connection-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
  }

  .credentials-context {
    margin: 0;
    color: var(--s-ink-3);
  }
  .credentials-context code {
    font-family: var(--s-font-mono);
    background: var(--s-paper-deep);
    padding: 1px 4px;
    border-radius: 4px;
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

</style>
