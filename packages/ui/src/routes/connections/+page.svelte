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
    mintPairingCode,
    type AssistantConnection,
  } from '$lib/api.js';
  import type { ConnectionKind } from '$lib/types.js';
  import { hasCapability, runtimeContext } from '$lib/runtime-context.svelte.js';

  // Capability-guarded surface (plan ui-runtime-modes-plan.md Phase 2, #486):
  // this page replaces /admin/endpoints and works in every mode that
  // advertises `connections:manage` — the API it talks to enforces the
  // capability server-side; auth is enforced in hooks.server.ts.

  /** Add/edit form kind: 'local-opencode' is reserved for the synthesized
   *  env-derived default and is never offered here (#486 D2). */
  type FormKind = Extract<ConnectionKind, 'remote-opencode' | 'openpalm-client-api'>;

  // ── Form state ─────────────────────────────────────────────────────────
  let formMode = $state<'idle' | 'add' | 'edit'>('idle');
  let formId = $state<string | null>(null);
  let formLabel = $state('');
  let formUrl = $state('');
  // #486 D2: connection-kind selector.
  let formKind = $state<FormKind>('remote-opencode');
  let formPassword = $state('');
  let formClearPassword = $state(false);
  let formSubmitting = $state(false);
  let formError = $state('');

  // ── Per-row state ───────────────────────────────────────────────────────
  let deletingId = $state<string | null>(null);

  // ── Pairing panel state (#511 D3/D4/D6) ────────────────────────────────
  // The pairing panel mints a one-time QR/code that lets another device
  // (phone, laptop) add THIS stack as a guardian connection without typing a
  // long secret by hand. The minted secret only ever lives in `pairingCode`
  // — cleared entirely by `donePairing()` — never in `connectionsService` or
  // any persisted store.
  let pairingMode = $state<'idle' | 'form' | 'result'>('idle');
  let pairingLabel = $state('');
  let pairingUrl = $state('');
  let pairingSubmitting = $state(false);
  let pairingError = $state('');
  let pairingCode = $state('');
  // PR #564 retest P3-3: null when the host could not render the QR SVG — the
  // text code below is always shown, so pairing still works without a QR.
  let pairingQrSvg = $state<string | null>(null);
  let pairingWarnings = $state<string[]>([]);
  let pairingCopied = $state(false);

  const connections = $derived(connectionsService.endpoints);
  const active = $derived(connectionsService.active);
  const hostRoute = $derived(
    hasCapability('host:stack:read') ? runtimeContext.routes.host : undefined,
  );
  const exitRoute = $derived(hostRoute ?? runtimeContext.routes.chat ?? '/chat');
  const exitLabel = $derived(hostRoute ? 'Back to Admin' : 'Back to Chat');

  onMount(() => {
    void connectionsService.load(true);
    // The /connections/new landing (plan §6.5, Phase 3) aliases here with
    // ?new=1 — open the add form so "no connections yet" starts at the form.
    if (page.url.searchParams.get('new') === '1') openAddForm();
  });

  function openPairingForm(): void {
    pairingMode = 'form';
    pairingLabel = '';
    pairingUrl = '';
    pairingError = '';
  }

  function cancelPairing(): void {
    pairingMode = 'idle';
    pairingError = '';
  }

  async function submitPairing(ev: Event): Promise<void> {
    ev.preventDefault();
    if (pairingSubmitting) return;
    const label = pairingLabel.trim();
    const url = pairingUrl.trim();
    if (!label || !url) {
      pairingError = 'Label and URL are required.';
      return;
    }

    pairingSubmitting = true;
    pairingError = '';
    try {
      const result = await mintPairingCode({ label, url });
      pairingCode = result.code;
      pairingQrSvg = result.qrSvg;
      pairingWarnings = result.warnings;
      pairingCopied = false;
      pairingMode = 'result';
    } catch (e) {
      const err = e as { message?: string };
      pairingError = err.message ?? 'Pairing failed.';
    } finally {
      pairingSubmitting = false;
    }
  }

  async function copyPairingCode(): Promise<void> {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode);
      pairingCopied = true;
    } catch {
      pairingError = 'Copy failed — select the code and copy manually.';
    }
  }

  /** Clears the panel state — the code is shown only once and is never kept
   *  in component state (or anywhere else) after this. */
  function donePairing(): void {
    pairingMode = 'idle';
    pairingCode = '';
    pairingQrSvg = null;
    pairingWarnings = [];
    pairingCopied = false;
  }

  function openAddForm(): void {
    formMode = 'add';
    formId = null;
    formLabel = '';
    formUrl = '';
    formKind = 'remote-opencode';
    formPassword = '';
    formClearPassword = false;
    formError = '';
  }

  function openEditForm(c: AssistantConnection): void {
    formMode = 'edit';
    formId = c.id;
    formLabel = c.label;
    formUrl = c.url;
    formKind = c.kind === 'openpalm-client-api' ? 'openpalm-client-api' : 'remote-opencode';
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
          kind: formKind,
          ...(formPassword ? { password: formPassword } : {}),
        });
      } else if (formMode === 'edit' && formId) {
        const patch: { label: string; url: string; kind: ConnectionKind; password?: string | null } = {
          label,
          url,
          kind: formKind,
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
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- destination comes from runtimeContext.routes, not a static route id -->
      <a class="back-link" href={exitRoute} aria-label={exitLabel}>← {exitLabel}</a>
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
              {#if conn.kind === 'openpalm-client-api'}<span class="badge kind">guardian</span>{/if}
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

    {#if formMode === 'idle' && pairingMode === 'idle'}
      <div class="toolbar-row">
        <button type="button" class="btn btn-primary" onclick={openAddForm}>
          + Add connection
        </button>
        {#if hasCapability('host:stack:write')}
          <button type="button" class="btn btn-secondary" onclick={openPairingForm}>
            Pair a device
          </button>
        {/if}
      </div>
    {:else if formMode !== 'idle'}
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

        <!-- #486 D2: connection-kind selector. 'local-opencode' is reserved
             for the synthesized env-derived default and is never offered
             here — only the two user-addable kinds. -->
        <label class="field">
          <span>Kind</span>
          <select bind:value={formKind}>
            <option value="remote-opencode">OpenCode server (direct)</option>
            <option value="openpalm-client-api">OpenPalm guardian (/oc)</option>
          </select>
          <small>
            {#if formKind === 'openpalm-client-api'}
              The "Shared network, guardian protected" story — connect to the guardian's protected front door.
            {:else}
              A direct OpenCode connection is the supported "Home network" preset story (Setup → Network access),
              not a dev/advanced-only path.
            {/if}
          </small>
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
          {#if formKind === 'openpalm-client-api'}
            <small>The guardian's base URL — <code>/oc</code> is appended automatically if you leave it off.</small>
          {:else}
            <small>The host:port where the remote OpenPalm assistant (OpenCode) is reachable.</small>
          {/if}
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
            Forwarded as HTTP Basic auth. Only required for a remote assistant running the
            <strong>Home network, with password</strong> network access preset (<code>OPENCODE_AUTH=true</code>).
          </small>
          {#if formMode === 'edit'}
            <small class="rotate-hint">
              <strong>Rotating this password?</strong>
              The password lives as the file secret <code>knowledge/secrets/op_opencode_password</code> on the
              remote host — never in <code>stack.env</code>. Rotation is a two-step process:
              <ol>
                <li>
                  On the remote host: re-run setup's Network access step (choose
                  <strong>Home network, with password</strong> again with the new password), or edit
                  <code>knowledge/secrets/op_opencode_password</code> directly and restart the
                  <code>assistant</code> container.
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
    {:else if pairingMode === 'form'}
      <form class="connection-form" onsubmit={submitPairing}>
        <h2>Pair a device</h2>
        <p class="lede">
          Mint a one-time QR code / pairing code for another device (phone, laptop) to add this
          stack as a connection. The code contains a fresh, individually-revocable credential — it
          is shown only once.
        </p>

        <label class="field">
          <span>Label</span>
          <input
            type="text"
            bind:value={pairingLabel}
            placeholder="e.g. My phone"
            required
            autocomplete="off"
          />
        </label>

        <label class="field">
          <span>Guardian URL (as reachable BY THE OTHER DEVICE)</span>
          <input
            type="url"
            bind:value={pairingUrl}
            placeholder="https://gw.example.ts.net or http://10.0.0.5:3830"
            required
            autocomplete="off"
          />
          <small>
            Use the LAN address or Tailscale/ts.net hostname the other device can actually reach —
            not <code>127.0.0.1</code>. Remote (non-loopback) origins must be reachable over HTTPS
            and allow-listed via <code>GUARDIAN_CORS_ALLOWED_ORIGINS</code>; see
            <a
              href="https://github.com/itlackey/openpalm/blob/main/docs/remote-access-tls.md"
              target="_blank"
              rel="noopener noreferrer"
            >remote-access-tls.md</a>.
          </small>
        </label>

        {#if pairingError}
          <div class="alert error" role="alert">{pairingError}</div>
        {/if}

        <div class="form-actions">
          <button type="submit" class="btn btn-primary" disabled={pairingSubmitting}>
            {pairingSubmitting ? 'Minting…' : 'Mint pairing code'}
          </button>
          <button type="button" class="btn btn-secondary" onclick={cancelPairing} disabled={pairingSubmitting}>
            Cancel
          </button>
        </div>
      </form>
    {:else if pairingMode === 'result'}
      <section class="connection-form pairing-result" aria-label="Pairing code">
        <h2>Scan or copy the pairing code</h2>
        <p class="alert warn" role="status">
          This code will be shown only once and won't be shown again — copy it or scan it now.
          It carries a live credential; the underlying device principal can be revoked later from
          this stack's guardian if needed.
        </p>

        {#if pairingQrSvg}
          <div class="pairing-qr">{@html pairingQrSvg}</div>
        {:else}
          <p class="alert" role="status">
            The QR image couldn't be generated on this stack — scan isn't available, but the
            pairing code below works exactly the same. Copy it into the new device.
          </p>
        {/if}

        <div class="field">
          <span id="pairing-code-label">Pairing code</span>
          <code class="pairing-code" aria-labelledby="pairing-code-label">{pairingCode}</code>
        </div>

        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick={copyPairingCode}>
            {pairingCopied ? 'Copied' : 'Copy code'}
          </button>
        </div>

        {#if pairingWarnings.length > 0}
          <ul class="alert warn pairing-warnings">
            {#each pairingWarnings as warning}
              <li>{warning}</li>
            {/each}
          </ul>
        {/if}

        <p class="lede">
          On the other device, open the connections page and paste this code (or scan the QR with
          any camera/QR app), or use it as the <code>?pair=</code> link if this stack has a hosted
          client origin. Non-local client origins also need
          <code>GUARDIAN_CORS_ALLOWED_ORIGINS</code> set for this guardian.
        </p>

        <div class="form-actions">
          <button type="button" class="btn btn-primary" onclick={donePairing}>
            Done
          </button>
        </div>
      </section>
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
  .back-link {
    display: inline-block;
    margin-bottom: var(--s-sp-3);
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    text-decoration: none;
  }
  .back-link:hover {
    color: var(--s-ink);
    text-decoration: underline;
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

  .alert.warn {
    padding: var(--s-sp-3);
    border-radius: 2px;
    background: var(--s-paper-deep);
    color: var(--s-ink);
    border: 1px solid var(--s-line);
    margin: 0;
  }
  ul.pairing-warnings {
    padding-left: var(--s-sp-5);
  }

  .toolbar-row {
    display: flex;
    gap: var(--s-sp-2);
  }

  .pairing-qr :global(svg) {
    width: 200px;
    height: 200px;
    max-width: 100%;
  }
  .pairing-code {
    display: block;
    word-break: break-all;
    padding: var(--s-sp-2) var(--s-sp-3);
    background: var(--s-paper-deep);
    border-radius: 2px;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
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
  .badge.kind {
    background: var(--s-paper-deep);
    color: var(--s-ink-3);
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
