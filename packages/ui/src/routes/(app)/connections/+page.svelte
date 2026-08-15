<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { goto, replaceState } from '$app/navigation';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import DeviceSettingsNav from '$lib/components/chrome/DeviceSettingsNav.svelte';
  import SurfaceToolbar from '$lib/components/chrome/SurfaceToolbar.svelte';
  import PwaInstall from '$lib/components/settings/PwaInstall.svelte';
  import VoiceClientSettings from '$lib/components/voice/VoiceClientSettings.svelte';
  import IconLock from '$lib/components/icons/IconLock.svelte';
  import {
    endpointsService as connectionsService,
    type ConnectionView,
  } from '$lib/endpoints-state.svelte.js';
  import { mintPairingCode } from '$lib/api.js';
  import { fetchAssistantKey, type AssistantKey } from '$lib/api/akm.js';
  import { getConnectionStorageMode, getConnectionStore, getSecretStore } from '$lib/connections/boot.js';
  import { connectionSecretsEncryptedAtRest } from '$lib/connections/secrets.js';
  import { newConnectionId } from '$lib/connections/store.js';
  import { isDiscoveryCandidateUrl, markLocalDiscoveryDismissed } from '$lib/connections/discovery.js';
  import { validateConnectionUrl } from '$lib/connections/url-policy.js';
  import { getRuntimeContext, hasCapability } from '$lib/runtime-context.svelte.js';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import {
    buildAdvancedPath,
    buildChatPath,
    buildReturnToPath,
    currentChatSessionId,
    resolveReturnToPath,
  } from '$lib/chat/navigation.js';
  import type { ThemePreference } from '$lib/theme-state.svelte.js';
  import { themeService } from '$lib/theme-state.svelte.js';
  import { removeManagedConnection, updateManagedConnection } from './management.js';

  type SettingsTab = 'general' | 'connections';
  const runtimeContext = getRuntimeContext();

  let { data }: { data: import('./$types').PageData } = $props();

  // F6: a 14-day sliding session had no UI control to end it on a shared
  // machine, despite POST /api/auth/logout already existing server-side. The
  // control now lives here rather than floating over the chat thread, and it
  // renders only when `data.signedIn` — see +page.server.ts for why an
  // ungated sign-out is a dead end in the client-only lane.
  async function handleSignOut(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // Best-effort — land on /login regardless; if the network is down the
      // cookie may already be unusable anyway.
    }
    const redirectTo = encodeURIComponent(`${page.url.pathname}${page.url.search}`);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- static internal route
    await goto(`/login?redirectTo=${redirectTo}`);
  }

  function initialSettingsTab(): SettingsTab {
    const requested = page.url.searchParams.get('tab');
    if (requested === 'general' || requested === 'connections') return requested;
    return page.url.searchParams.get('new') === '1' ? 'connections' : 'general';
  }

  // Capability-guarded surface (#486):
  // this page replaces /admin/endpoints and works in every mode that
  // advertises `connections:manage` — the API it talks to enforces the
  // capability server-side; auth is enforced in hooks.server.ts.

  // ── Form state ─────────────────────────────────────────────────────────
  let formMode = $state<'idle' | 'edit'>('idle');
  let formId = $state<string | null>(null);
  let formLabel = $state('');
  let formUrl = $state('');
  let formUsername = $state('');
  let formPassword = $state('');
  // The local install's OpenCode key (system-generated; auth is always on).
  // Loaded lazily on reveal, never on page load; the route answers with
  // Cache-Control: no-store and the value is never logged.
  let assistantKey = $state<AssistantKey | null>(null);
  let assistantKeyLoading = $state(false);
  let assistantKeyCopied = $state(false);
  let assistantKeyError = $state('');

  async function revealAssistantKey(): Promise<void> {
    assistantKeyLoading = true;
    assistantKeyError = '';
    try {
      assistantKey = await fetchAssistantKey();
    } catch (error) {
      assistantKeyError = error instanceof Error ? error.message : String(error);
    } finally {
      assistantKeyLoading = false;
    }
  }

  async function copyAssistantKey(): Promise<void> {
    if (!assistantKey?.available) return;
    try {
      await navigator.clipboard.writeText(assistantKey.password);
      assistantKeyCopied = true;
      window.setTimeout(() => {
        assistantKeyCopied = false;
      }, 2000);
    } catch {
      assistantKeyError = 'Clipboard unavailable — copy the value manually.';
    }
  }
  let formClearPassword = $state(false);
  let formSubmitting = $state(false);
  let formError = $state('');
  let formGuideUrl = $state<string | null>(null);
  let formDisclosurePending = $state(false);
  // ── Per-row state ───────────────────────────────────────────────────────
  let deletingId = $state<string | null>(null);
  let activeTab = $state<SettingsTab>(initialSettingsTab());

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
  const fallbackChatHref = $derived.by(() => {
    const sessionId = currentChatSessionId();
    const assistantId = connectionsService.activeId || null;
    return advancedModeService.enabled
      ? buildAdvancedPath(sessionId, assistantId)
      : buildChatPath(sessionId, assistantId);
  });
  const chatReturnHref = $derived(
    resolveReturnToPath(page.url.searchParams.get('returnTo'), fallbackChatHref),
  );
  const settingsHref = $derived(
    buildReturnToPath(resolve('/connections'), chatReturnHref),
  );
  const hostSettingsHref = $derived(
    buildReturnToPath(resolve('/host'), chatReturnHref),
  );

  onMount(() => {
    advancedModeService.init();
    if (routePairDeepLink()) return;
    if (page.url.searchParams.get('new') === '1') {
      routeNewConnection(false);
      return;
    }
    void connectionsService.load(true);
  });

  function routeNewConnection(includeFragment: boolean): void {
    const searchParams = new SvelteURLSearchParams(page.url.searchParams);
    searchParams.delete('new');
    searchParams.delete('tab');
    const query = searchParams.toString();
    const fragment = includeFragment ? window.location.hash : '';
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- target starts with the resolved wizard route and retains browser-only query/fragment state
    void goto(`${resolve('/connections/new')}${query ? `?${query}` : ''}${fragment}`, {
      replaceState: true,
    });
  }

  function routePairDeepLink(): boolean {
    if (!new URLSearchParams(window.location.hash.slice(1)).has('pair')) return false;
    routeNewConnection(true);
    return true;
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

  function selectSettingsTab(tab: SettingsTab): void {
    activeTab = tab;
    const searchParams = new SvelteURLSearchParams(page.url.searchParams);
    searchParams.set('tab', tab);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- same-page settings state
    replaceState(`${page.url.pathname}?${searchParams}${page.url.hash}`, {});
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
    formError = '';
    formGuideUrl = null;
    formDisclosurePending = false;
  }

  function cancelForm(): void {
    formMode = 'idle';
    formError = '';
    formGuideUrl = null;
    formDisclosurePending = false;
  }

  async function submitForm(ev: Event): Promise<void> {
    ev.preventDefault();
    await saveEdit(false);
  }

  async function saveEdit(storageDisclosureAccepted: boolean): Promise<void> {
    if (formSubmitting) return;
    const label = formLabel.trim();
    const url = formUrl.trim();
    if (!label || !url) {
      formError = 'Label and URL are required.';
      formGuideUrl = null;
      return;
    }
    const urlVerdict = validateConnectionUrl(url);
    if (!urlVerdict.ok) {
      formError = urlVerdict.message;
      formGuideUrl = urlVerdict.reason === 'insecure-remote' ? urlVerdict.guideUrl : null;
      return;
    }
    const username = formUsername.trim() || 'opencode';

    formSubmitting = true;
    formError = '';
    formGuideUrl = null;
    try {
      const store = getConnectionStore();
      const secrets = getSecretStore();
      if (formMode !== 'edit' || !formId) return;
      if (formPassword && !storageDisclosureAccepted) {
        const storageMode = await getConnectionStorageMode();
        if (storageMode === 'persistent' && !connectionSecretsEncryptedAtRest()) {
          formDisclosurePending = true;
          return;
        }
      }
      formDisclosurePending = false;
      const result = await updateManagedConnection(
        {
          connectionId: formId,
          label,
          baseUrl: url,
          username,
          password: formPassword,
          clearPassword: formClearPassword,
        },
        { store, secrets, createId: newConnectionId },
      );
      if (!result.ok) {
        formError = result.error;
        return;
      }
      await connectionsService.load(true);
      formMode = 'idle';
      formDisclosurePending = false;
      if (result.warning) connectionsService.error = result.warning;
    } catch (e) {
      const err = e as { message?: string };
      formError = err.message ?? 'Save failed.';
    } finally {
      formSubmitting = false;
    }
  }

  async function continueEditWithUnprotectedStorage(): Promise<void> {
    await saveEdit(true);
  }

  function cancelEditDisclosure(): void {
    formDisclosurePending = false;
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
      const result = await removeManagedConnection(c.id, { store, secrets: getSecretStore() });
      if (!result.ok) {
        connectionsService.error = result.error;
        return;
      }
      // Removing an auto-discovered local entry is a "stop offering this"
      // signal — record it so discovery doesn't resurrect the card on the
      // next load.
      if (isDiscoveryCandidateUrl(c.url)) markLocalDiscoveryDismissed();
      await connectionsService.load(true);
      if (result.warning) connectionsService.error = result.warning;
    } catch (err) {
      const e2 = err as { message?: string };
      connectionsService.error = e2.message ?? 'Delete failed.';
    } finally {
      deletingId = null;
    }
  }

  function setTheme(preference: ThemePreference): void {
    themeService.setPreference(preference);
  }
</script>

<svelte:head>
  <title>Settings — OpenPalm</title>
</svelte:head>

<!-- A fragment-only pairing link can target an already-open Settings tab. -->
<svelte:window onhashchange={routePairDeepLink} />

<Navbar brandHref={chatReturnHref} showUtilities={false}>
  <SurfaceToolbar
    {settingsHref}
    hostHref={hasCapability(runtimeContext, 'host:stack:read') ? hostSettingsHref : undefined}
    conversationHref={chatReturnHref}
    settingsCurrent
    compact
  />
</Navbar>
<DeviceSettingsNav {activeTab} onTabChange={selectSettingsTab} />

<main class="page">
  <header class="page-header">
    <span class="page-kicker">This device</span>
    <h1>Settings</h1>
    <p class="lede">
      Manage the connections and preferences stored in this browser on this device.
    </p>
  </header>

  {#if activeTab === 'connections'}
    <div
      id="settings-panel-connections"
      class="settings-section tab-panel"
      role="tabpanel"
      aria-labelledby="settings-tab-connections"
    >
    <header class="section-header">
      <h2 id="connections-heading">Connections</h2>
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
        <a class="btn btn-primary" href={resolve('/connections/new')}>
          + Add connection
        </a>
        {#if hasCapability(runtimeContext, 'host:stack:write')}
          <button type="button" class="btn btn-secondary" onclick={openPairingForm}>
            Pair a device
          </button>
        {/if}
      </div>
    {:else if formMode !== 'idle'}
      <form class="connection-form" novalidate onsubmit={submitForm}>
        <h2>Edit connection</h2>

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
            placeholder="http://10.0.0.5:3810"
            required
            autocomplete="off"
          />
          <small>
            The full base URL of the OpenCode API — a direct assistant (e.g.
            <code>http://10.0.0.5:3810</code>) or a guardian front door including its
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
            placeholder="Leave blank to keep current"
            autocomplete="new-password"
          />
          <small>
            Forwarded as HTTP Basic auth. An OpenPalm assistant always requires its server
            password for direct API connections — the
            <strong>Allow direct connections to the assistant API</strong> access toggle only
            publishes the port.
          </small>
            <small class="rotate-hint">
              <strong>Rotating this password?</strong>
              The password lives as the file secret <code>private/secrets/op_opencode_password</code> on the
              remote host — never in <code>stack.env</code>. Rotation is a two-step process:
              <ol>
                <li>
                  On the remote host: edit <code>private/secrets/op_opencode_password</code> directly (or
                  reveal the current value below when this browser is on that host's admin process),
                  then restart the <code>assistant</code> container so it re-reads the file.
                </li>
                <li>Paste the new value here and save.</li>
              </ol>
            </small>
            {#if hasCapability(runtimeContext, 'host:stack:read')}
              <small class="assistant-key-reveal">
                {#if assistantKey === null}
                  <button type="button" class="btn btn-secondary btn-sm" onclick={() => void revealAssistantKey()} disabled={assistantKeyLoading}>
                    {assistantKeyLoading ? 'Loading…' : "Reveal this install's assistant key"}
                  </button>
                {:else if assistantKey.available}
                  This install's key: <code>{assistantKey.username}</code> /
                  <code>{assistantKey.password}</code>
                  <button type="button" class="btn btn-secondary btn-sm" onclick={() => void copyAssistantKey()}>
                    {assistantKeyCopied ? 'Copied' : 'Copy password'}
                  </button>
                {:else}
                  No assistant key is resolvable on this host (is OpenPalm installed here?).
                {/if}
                {#if assistantKeyError}<span class="error-text">{assistantKeyError}</span>{/if}
              </small>
            {/if}
        </label>

          <label class="field-inline">
            <input type="checkbox" bind:checked={formClearPassword} />
            <span>Clear stored password</span>
          </label>

        {#if formDisclosurePending}
          <div class="alert warn" role="alert" aria-labelledby="edit-storage-warning-title">
            <strong id="edit-storage-warning-title">This browser cannot protect saved passwords</strong>
            <p>
              If you continue, this connection password will be saved on this device without encryption.
              Continue only on a device you trust.
            </p>
          </div>
        {/if}

        {#if formError}
          <div class="alert error" role="alert">
            <span>{formError}</span>
            {#if formGuideUrl}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external URL supplied by the connection policy -->
              <a href={formGuideUrl} target="_blank" rel="noopener noreferrer">Open the TLS setup guide</a>
            {/if}
          </div>
        {/if}

        {#if formDisclosurePending}
          <div class="form-actions">
            <button
              type="button"
              class="btn btn-primary"
              onclick={continueEditWithUnprotectedStorage}
              disabled={formSubmitting}
            >
              {formSubmitting ? 'Saving…' : 'Save anyway'}
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              onclick={cancelEditDisclosure}
              disabled={formSubmitting}
            >
              Back
            </button>
          </div>
        {:else}
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" disabled={formSubmitting}>
            {formSubmitting ? 'Saving…' : 'Save'}
          </button>
          <button type="button" class="btn btn-secondary" onclick={cancelForm} disabled={formSubmitting}>
            Cancel
          </button>
        </div>
        {/if}
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
          <img
            class="pairing-qr"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairingQrSvg)}`}
            alt="QR code for pairing this device"
            width="200"
            height="200"
          />
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
            {#each pairingWarnings as warning (warning)}
              <li>{warning}</li>
            {/each}
          </ul>
        {/if}

        <p class="lede">
          On the other device, open Connect to OpenPalm and paste this code (or scan the QR with
          any camera/QR app), or use it as the <code>#pair=</code> URL-fragment link if this stack
          has a hosted client origin — the fragment keeps the credential out of server logs.
          Non-local client origins also need
          <code>GUARDIAN_CORS_ALLOWED_ORIGINS</code> set for this guardian.
        </p>

        <div class="form-actions">
          <button type="button" class="btn btn-primary" onclick={donePairing}>
            Done
          </button>
        </div>
      </section>
    {/if}
    </div>
  {:else}
    <div
      id="settings-panel-general"
      class="tab-panel settings-grid"
      role="tabpanel"
      aria-labelledby="settings-tab-general"
    >
      <section id="appearance" class="settings-section" aria-labelledby="appearance-heading">
        <header class="section-header">
          <h2 id="appearance-heading">Appearance</h2>
          <p class="lede">Use your system theme or choose one for this device.</p>
        </header>
        <div class="theme-options" role="group" aria-label="Appearance">
          {#each ['system', 'light', 'dark'] as preference (preference)}
            <button
              type="button"
              class:active={themeService.preference === preference}
              aria-pressed={themeService.preference === preference}
              onclick={() => setTheme(preference as ThemePreference)}
            >{preference[0].toUpperCase() + preference.slice(1)}</button>
          {/each}
        </div>
      </section>

      {#if hasCapability(runtimeContext, 'pwa:install') && !hasCapability(runtimeContext, 'host:stack:read')}
        <section id="app-install" class="settings-section" aria-labelledby="app-install-heading">
          <header class="section-header">
            <h2 id="app-install-heading">App</h2>
            <p class="lede">Install OpenPalm for a focused, app-like window on this device.</p>
          </header>
          <PwaInstall />
        </section>
      {/if}

      <section id="voice" class="settings-section voice-section" aria-labelledby="voice-heading">
        <header class="section-header">
          <h2 id="voice-heading">Voice</h2>
          <p class="lede">
            Choose speech input, language, and spoken response behavior for this browser.
          </p>
        </header>
        <VoiceClientSettings />
      </section>

      {#if data.signedIn}
        <section id="session" class="settings-section session-section" aria-labelledby="session-heading">
          <header class="section-header">
            <h2 id="session-heading">Session</h2>
            <p class="lede">
              You are signed in on this device. Signing out asks for the password again on the
              next visit; your saved connections stay on this device either way.
            </p>
          </header>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick={() => void handleSignOut()}>
              Sign out
            </button>
          </div>
        </section>
      {/if}

    </div>
  {/if}
</main>

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: var(--s-sp-6);
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-5);
  }
  .page-header h1 {
    margin: var(--s-sp-1) 0 var(--s-sp-2);
  }
  .page-header {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }
  .page-kicker {
    color: var(--s-seal);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .theme-options button:focus-visible {
    outline: 2px solid var(--s-ink);
    outline-offset: 2px;
  }
  .settings-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-4);
  }

  .tab-panel {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-5);
  }
  .settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }
  .voice-section,
  .session-section {
    grid-column: 1 / -1;
  }
  .section-header h2 {
    margin: 0 0 var(--s-sp-2);
  }
  .lede {
    color: var(--s-ink-3);
    margin: 0;
  }

  .theme-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s-sp-1);
    width: 100%;
    padding: var(--s-sp-1);
    border-radius: 8px;
    background: var(--s-paper-deep);
  }
  .theme-options button {
    min-width: 44px;
    min-height: 44px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--s-ink-2);
    font: inherit;
    cursor: pointer;
  }
  .theme-options button:hover {
    color: var(--s-ink);
  }
  .theme-options button.active {
    background: var(--s-paper);
    color: var(--s-ink);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--s-ink) 15%, transparent);
    font-weight: 700;
  }

  .alert.error {
    padding: var(--s-sp-3);
    border-radius: 2px;
    background: color-mix(in srgb, var(--s-seal) 8%, transparent);
    color: var(--s-seal);
    border: 1px solid color-mix(in srgb, var(--s-seal) 25%, transparent);
  }
  .alert.error a {
    display: inline-block;
    margin-top: var(--s-sp-2);
    color: inherit;
    font-weight: 700;
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

  .pairing-qr {
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

  @media (max-width: 480px) {
    .page {
      padding: var(--s-sp-3);
    }
  }

  @media (max-width: 760px) {
    .settings-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .voice-section,
    .session-section {
      grid-column: auto;
    }
  }
</style>
