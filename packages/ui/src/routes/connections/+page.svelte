<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { replaceState } from '$app/navigation';
  import ChatNavbar from '$lib/components/chrome/ChatNavbar.svelte';
  import IconLock from '@openpalm/ui-kit/components/icons/IconLock.svelte';
  import {
    endpointsService as connectionsService,
    type ConnectionView,
  } from '$lib/endpoints-state.svelte.js';
  import { mintPairingCode } from '$lib/api.js';
  import { getConnectionStore, getSecretStore } from '$lib/connections/boot.js';
  import { parsePairingCode, type PairingPayload } from '$lib/connections/pairing.js';
  import { hasCapability, runtimeContext } from '$lib/runtime-context.svelte.js';

  // Capability-guarded surface (plan ui-runtime-modes-plan.md Phase 2, #486):
  // this page replaces /admin/endpoints and works in every mode that
  // advertises `connections:manage` — the API it talks to enforces the
  // capability server-side; auth is enforced in hooks.server.ts.

  // ── Form state ─────────────────────────────────────────────────────────
  let formMode = $state<'idle' | 'add' | 'edit'>('idle');
  let formId = $state<string | null>(null);
  let formLabel = $state('');
  let formUrl = $state('');
  let formUsername = $state('');
  let formPassword = $state('');
  let formClearPassword = $state(false);
  let formSubmitting = $state(false);
  let formError = $state('');
  // #511 D3/D4: "Have a pairing code?" paste field, shown at the top of the
  // add form. Applying a code prefills the same fields a manual entry uses; the
  // secret then flows through the existing secret-store path below.
  let pairingPasteCode = $state('');

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

    // #511 D3/D4: ?pair= deep link — parse, open the add form prefilled, then
    // strip the credential-bearing parameter from history so the code doesn't
    // linger in the URL bar.
    const pairParam = page.url.searchParams.get('pair');
    if (pairParam) {
      const result = parsePairingCode(pairParam);
      if (result.ok) {
        openAddForm();
        applyPairingPayload(result.payload);
      } else {
        openAddForm();
        formError = result.error;
      }
      const url = new URL(page.url);
      url.searchParams.delete('pair');
      replaceState(url, {});
    }
  });

  /** Prefill the add form from a decoded pairing payload. The secret then flows
   *  through the existing secret-store path on submit — the stored connection
   *  carries only auth.secretRef, never the raw secret. */
  function applyPairingPayload(payload: PairingPayload): void {
    formLabel = payload.label ?? formLabel;
    formUrl = payload.url;
    formUsername = payload.username;
    formPassword = payload.secret;
    pairingPasteCode = '';
    formError = '';
  }

  function applyPairingPaste(): void {
    const code = pairingPasteCode.trim();
    if (!code) return;
    const result = parsePairingCode(code);
    if (!result.ok) {
      formError = result.error;
      return;
    }
    applyPairingPayload(result.payload);
  }

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
    formUsername = '';
    formPassword = '';
    formClearPassword = false;
    pairingPasteCode = '';
    formError = '';
  }

  function openEditForm(c: ConnectionView): void {
    formMode = 'edit';
    formId = c.id;
    formLabel = c.label;
    formUrl = c.url;
    // Username is stored inline on the connection's auth; the password lives
    // encrypted in the secret store and is never re-displayed.
    formUsername = c.auth.mode === 'basic' ? c.auth.username : '';
    formPassword = '';
    formClearPassword = false;
    pairingPasteCode = '';
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
    const username = formUsername.trim() || 'opencode';

    formSubmitting = true;
    formError = '';
    try {
      const store = getConnectionStore();
      const secrets = getSecretStore();
      if (formMode === 'add') {
        if (formPassword) {
          const secretRef = crypto.randomUUID();
          await secrets.set(secretRef, { username, password: formPassword });
          await store.add({ label, baseUrl: url, auth: { mode: 'basic', username, secretRef } });
        } else {
          await store.add({ label, baseUrl: url, auth: { mode: 'none' } });
        }
      } else if (formMode === 'edit' && formId) {
        const existing = await store.get(formId);
        const currentRef = existing?.auth.mode === 'basic' ? existing.auth.secretRef : null;
        if (formClearPassword) {
          if (currentRef) await secrets.delete(currentRef);
          await store.update(formId, { label, baseUrl: url, auth: { mode: 'none' } });
        } else if (formPassword) {
          const secretRef = currentRef ?? crypto.randomUUID();
          await secrets.set(secretRef, { username, password: formPassword });
          await store.update(formId, { label, baseUrl: url, auth: { mode: 'basic', username, secretRef } });
        } else if (currentRef) {
          // Keep the stored password; the username may still have changed.
          await secrets.updateUsername(currentRef, username);
          await store.update(formId, { label, baseUrl: url, auth: { mode: 'basic', username, secretRef: currentRef } });
        } else {
          await store.update(formId, { label, baseUrl: url, auth: { mode: 'none' } });
        }
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

  async function remove(c: ConnectionView): Promise<void> {
    if (c.isDefault) return;
    if (!confirm(`Remove connection "${c.label}"?`)) return;
    deletingId = c.id;
    try {
      const store = getConnectionStore();
      if (c.auth.mode === 'basic') await getSecretStore().delete(c.auth.secretRef);
      await store.remove(c.id);
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

        {#if formMode === 'add'}
          <label class="field">
            <span>Have a pairing code?</span>
            <div class="paste-row">
              <input
                type="text"
                bind:value={pairingPasteCode}
                placeholder="openpalm-pair:…"
                autocomplete="off"
              />
              <button type="button" class="btn btn-secondary btn-sm" onclick={applyPairingPaste}>
                Apply
              </button>
            </div>
            <small>Paste a code from another stack's “Pair a device” panel to prefill this form.</small>
          </label>
        {/if}

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
          <small>
            The full base URL of the OpenCode API — a direct assistant (e.g.
            <code>http://10.0.0.5:3800</code>) or a guardian front door including its
            <code>/oc</code> path. OpenPalm speaks native OpenCode against either.
          </small>
        </label>

        <label class="field">
          <span>Username (optional)</span>
          <input
            type="text"
            bind:value={formUsername}
            placeholder="opencode"
            autocomplete="off"
          />
          <small>Basic-auth username. Defaults to <code>opencode</code> (OpenCode's server default).</small>
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

  .paste-row {
    display: flex;
    gap: var(--s-sp-2);
  }
  .paste-row input {
    flex: 1;
    min-width: 0;
    padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    font: inherit;
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
