<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import {
    fetchAccessStatus,
    fetchAssistantPersona,
    fetchHostStackSettings,
    saveAssistantPersona,
    saveHostStackSettings,
    type AccessStatus,
    type MdnsSurface,
  } from '$lib/api.js';
  import { getRuntimeContext, hasCapability } from '$lib/runtime-context.svelte.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import {
    ACCESS_TOGGLE_DEFAULTS,
    ACCESS_TOGGLE_DESCRIPTIONS,
    ACCESS_TOGGLE_KEYS,
    ACCESS_TOGGLE_LABELS,
    type AccessToggles,
  } from '@openpalm/lib/control-plane/access-toggles.js';

  // Phase 4 split: host
  // STACK settings (project name, bind address → /api/host/stack) are a
  // separate concern from ASSISTANT settings (persona → /api/assistant/persona)
  // with separate capabilities, endpoints, and save actions. hasCapability()
  // is UX only — both endpoints enforce their capability server-side.

  let loading = $state(false);
  let error = $state('');

  // ── Host stack settings (host:stack:write) ─────────────────────────────────
  let stackSaving = $state(false);
  let projectName = $state('openpalm');
  let access: AccessToggles = $state({ ...ACCESS_TOGGLE_DEFAULTS });
  let stackEnvPath = $state('state/stack.env');
  let mdns: MdnsSurface | null = $state(null);
  // Progressive disclosure: guardian toggles only mean something once a
  // guardian-backed integration is enabled, and direct assistant exposure is
  // an advanced choice most installs never make.
  let showAdvancedAccess = $state(false);

  // "What URL do I open on my phone, and does it work?" (Phase 2 of the
  // LAN-access review) — loaded best-effort alongside the stack settings.
  // Failure here must never block the rest of the panel: it is a diagnostic
  // extra, not something project-name/persona editing depends on.
  let accessStatus: AccessStatus | null = $state(null);
  let copiedUrl = $state('');

  async function loadAccessStatus(): Promise<void> {
    if (!showStack) return;
    try {
      accessStatus = await fetchAccessStatus();
    } catch {
      accessStatus = null;
    }
  }

  async function copyUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      copiedUrl = url;
      setTimeout(() => { if (copiedUrl === url) copiedUrl = ''; }, 2000);
    } catch {
      // Clipboard access can be denied (permissions, insecure context); the
      // URL is still selectable text, so this is a silent no-op rather than
      // an error banner over a non-essential convenience.
    }
  }

  // ── Assistant persona (assistant-settings:write) ───────────────────────────
  let personaSaving = $state(false);
  let personaPath = $state('config/assistant/persona.md');
  let personaContent = $state('');
  // Snapshot of last-saved persona content for dirty detection.
  let savedPersonaContent = $state('');

  const runtimeContext = getRuntimeContext();
  const showStack = $derived(hasCapability(runtimeContext, 'host:stack:read'));
  const canEditStack = $derived(hasCapability(runtimeContext, 'host:stack:write'));
  const showPersona = $derived(hasCapability(runtimeContext, 'assistant-settings:read'));
  const canEditPersona = $derived(hasCapability(runtimeContext, 'assistant-settings:write'));

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      if (showStack) {
        const stack = await fetchHostStackSettings();
        projectName = stack.projectName;
        access = { ...stack.access };
        stackEnvPath = stack.stackEnvPath;
        mdns = stack.mdns;
        await loadAccessStatus();
      }
      if (showPersona) {
        const persona = await fetchAssistantPersona();
        personaPath = persona.personaPath;
        personaContent = persona.personaContent;
        savedPersonaContent = persona.personaContent;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load assistant settings.';
    } finally {
      loading = false;
    }
  }

  async function saveStack(): Promise<void> {
    stackSaving = true;
    error = '';
    try {
      const data = await saveHostStackSettings({ projectName, access });
      projectName = data.projectName;
      access = { ...data.access };
      mdns = data.mdns;
      // No "now restart to apply" advice: the save IS the apply (the server
      // recreates the affected containers before responding). The old advice
      // was worse than redundant — `compose restart`, which is what both
      // `openpalm restart` and the Containers tab run, cannot republish a port,
      // so following it left the toggle silently inert.
      const recreated = data.recreated?.length
        ? ` Applied to ${data.recreated.join(', ')}.`
        : '';
      const autoEnabled = data.autoEnabledAddons?.length
        ? ` Enabled ${data.autoEnabledAddons.join(', ')} so the published port has a service behind it.`
        : '';
      notifications.push(
        'success',
        data.projectRenamed
          ? `Stack settings saved and applied.${recreated}${autoEnabled} Project name changed — run \`openpalm restart\` (or \`openpalm update\`) to move the whole stack to the new project name.`
          : `Stack settings saved and applied.${recreated}${autoEnabled}`,
      );
      // The apply above may have just made the front door reachable (or, on
      // failure, left it exactly as unreachable as before) — refresh the
      // chip/URLs so the panel does not keep showing pre-apply status.
      await loadAccessStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save stack settings.';
      error = msg;
      notifications.push('error', msg);
    } finally {
      stackSaving = false;
    }
  }

  async function savePersona(): Promise<void> {
    personaSaving = true;
    error = '';
    try {
      const data = await saveAssistantPersona({ personaContent });
      personaContent = data.personaContent;
      savedPersonaContent = data.personaContent;
      notifications.push('success', 'Persona saved. Restart the assistant container to apply it.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save persona.';
      error = msg;
      notifications.push('error', msg);
    } finally {
      personaSaving = false;
    }
  }

  let saving = $derived(stackSaving || personaSaving);
  let personaDirty = $derived(personaContent !== savedPersonaContent);

  onMount(() => { void load(); });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Assistant</h2>
      <p class="panel-subtitle">Persona · stack config</p>
    </div>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving}>
        {#if loading}<Spinner />{/if}
        Refresh
      </button>
    </div>
  </div>

  {#if error}<div class="error-banner"><span>{error}</span></div>{/if}

  <div class="settings-grid">
    {#if showStack}
      <section class="settings-card">
        <h3>Compose Project Name</h3>
        <p class="section-note">This writes <code>OP_PROJECT_NAME</code> in <code>{stackEnvPath}</code>. If unset, OpenPalm defaults to <code>openpalm</code>.</p>
        <label class="field" for="project-name">
          <span>Project name</span>
          <input id="project-name" class="control-input mono" type="text" spellcheck="false" placeholder="openpalm" bind:value={projectName} disabled={loading || saving || !canEditStack} />
        </label>
        <p class="field-hint">Lowercase letters, numbers, dashes, and underscores only. This affects Docker Compose naming and collision detection.</p>
      </section>

      <section class="settings-card">
        <h3>Network access</h3>
        <p class="section-note">Generated into <code>{stackEnvPath}</code>. Each switch opens exactly one door — nothing cascades.</p>

        <label class="field-inline" for="access-networkAccess">
          <input
            id="access-networkAccess"
            type="checkbox"
            checked={access.networkAccess}
            onchange={(e) => (access = { ...access, networkAccess: e.currentTarget.checked })}
            disabled={loading || saving || !canEditStack}
          />
          <span>{ACCESS_TOGGLE_LABELS.networkAccess}</span>
        </label>
        <p class="field-hint">{ACCESS_TOGGLE_DESCRIPTIONS.networkAccess}</p>

        <button
          type="button"
          class="access-advanced-toggle"
          onclick={() => (showAdvancedAccess = !showAdvancedAccess)}
        >
          {showAdvancedAccess ? 'Hide' : 'Show'} advanced access options
        </button>

        {#if showAdvancedAccess}
          {#each ACCESS_TOGGLE_KEYS.filter((k) => k !== 'networkAccess') as key (key)}
            <label class="field-inline" for={`access-${key}`}>
              <input
                id={`access-${key}`}
                type="checkbox"
                checked={access[key]}
                onchange={(e) => (access = { ...access, [key]: e.currentTarget.checked })}
                disabled={loading || saving || !canEditStack}
              />
              <span>{ACCESS_TOGGLE_LABELS[key]}</span>
            </label>
            <p class="field-hint">{ACCESS_TOGGLE_DESCRIPTIONS[key]}</p>
          {/each}
        {/if}

        {#if mdns}
          <div class="path-chip mdns-chip">
            <!-- The advertised port follows the front door: the UI when network
                 access is on, the OpenCode API when only that is published. -->
            {#if mdns.assistant.advertised}
              <span>Assistant: <a href={`http://${mdns.assistant.name}:${mdns.assistant.port}`}>http://{mdns.assistant.name}:{mdns.assistant.port}</a></span>
            {:else}
              <span class="mdns-muted">Assistant: {mdns.assistant.name}:{mdns.assistant.port} (not published)</span>
            {/if}
            {#if mdns.guardian.advertised}
              <span>Guardian: <a href={`http://${mdns.guardian.name}:${mdns.guardian.port}`}>http://{mdns.guardian.name}:{mdns.guardian.port}</a></span>
            {/if}
          </div>
          <p class="field-hint">Names derive from <code>OP_PROJECT_NAME</code> and are broadcast by the host <code>openpalm</code> process only while it runs.</p>
        {/if}
        {#if canEditStack}
          <div class="card-actions">
            <button class="btn btn-primary btn-sm" onclick={() => void saveStack()} disabled={loading || saving}>
              {#if stackSaving}<Spinner />{/if}
              Save stack settings
            </button>
          </div>
        {/if}
      </section>

      {#if accessStatus}
        <section class="settings-card">
          <h3>Open on your phone</h3>
          <p class="section-note">
            The address to type on another device, and whether it currently answers — separate from
            {ACCESS_TOGGLE_LABELS.networkAccess.toLowerCase()} being ON, since that only records intent
            until the container behind it is actually up.
          </p>

          <div class="reachable-row">
            <span class={`badge ${accessStatus.reachable.ok ? 'badge-running' : accessStatus.reachable.status === 'mismatch' ? 'badge-warning' : 'badge-error'}`}>
              {#if accessStatus.reachable.ok}
                Reachable
              {:else if accessStatus.reachable.status === 'mismatch'}
                Answering, but not the assistant UI
              {:else}
                Not reachable
              {/if}
            </span>
            <span class="field-hint">Loopback check of port {accessStatus.port}.</span>
          </div>

          <ul class="lan-url-list">
            {#each accessStatus.urls as url (url)}
              <li class="lan-url-row">
                <code class="lan-url">{url}</code>
                <button type="button" class="copy-btn" onclick={() => void copyUrl(url)}>
                  {copiedUrl === url ? 'Copied' : 'Copy'}
                </button>
              </li>
            {/each}
          </ul>
          <p class="field-hint">
            The <code>.local</code> name only resolves while a host <code>openpalm</code> process is
            running; the IP addresses work whenever this machine is on the same network.
          </p>
          <p class="field-hint">
            Away from home, these addresses won't reach it — set up
            <a href="/host?tab=addons&addon=remote">remote access</a> to use the assistant from
            anywhere.
          </p>
        </section>
      {/if}
    {/if}

    {#if showPersona}
      <section class="settings-card">
        <h3>Persona</h3>
        <p class="section-note">Edit the assistant persona markdown mounted into the assistant OpenCode instance.</p>
        <div class="path-chip">{personaPath}</div>
        <textarea class="control-input persona-editor mono" rows="20" spellcheck="false" bind:value={personaContent} disabled={loading || saving || !canEditPersona}></textarea>
        {#if canEditPersona}
          <div class="card-actions">
            {#if personaDirty}
              <span class="unsaved-hint" aria-live="polite">Unsaved changes</span>
            {/if}
            <button class="btn btn-primary btn-sm" onclick={() => void savePersona()} disabled={loading || saving || !personaDirty}>
              {#if personaSaving}<Spinner />{/if}
              Save persona
            </button>
          </div>
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .error-banner { color: var(--s-seal); padding: var(--s-sp-2) var(--s-sp-3); border: var(--s-hair) solid var(--s-seal); border-radius: 2px; margin-bottom: var(--s-sp-4); }
  .settings-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-sp-4); align-items: start; }
  .settings-card { border: var(--s-hair) solid var(--s-line-soft); border-radius: 2px; padding: var(--s-sp-4); background: none; }
  .settings-card h3 { margin: 0 0 var(--s-sp-2); font-family: var(--s-font-mono); font-size: var(--s-type-deed); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .section-note { margin: 0 0 var(--s-sp-3); font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-2); }
  .field { display: grid; gap: var(--s-sp-1); font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-2); }
  .access-advanced-toggle { align-self: flex-start; background: none; border: none; padding: 0; color: var(--s-ink-2); font-family: var(--s-font-display); font-size: var(--s-type-deed); text-decoration: underline; cursor: pointer; }
  .field-inline { display: flex; align-items: center; gap: var(--s-sp-2); font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }
  .control-input { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); background: none; border: 0; border-bottom: var(--s-hair) solid var(--s-line); border-radius: 0; padding: 0.5rem 0; width: 100%; }
  .control-input:focus { outline: none; border-bottom-color: var(--s-ink-2); }
  .mono { font-family: var(--s-font-mono); font-size: var(--s-type-mark); }
  .field-hint { margin: var(--s-sp-2) 0 0; font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-3); }
  .path-chip { display: inline-flex; align-items: center; margin-bottom: var(--s-sp-3); padding: var(--s-sp-1) var(--s-sp-2); border-radius: 2px; border: var(--s-hair) solid var(--s-line-soft); background: var(--s-paper-deep); color: var(--s-ink-3); font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); letter-spacing: var(--s-track-label); }
  .mdns-chip { flex-direction: column; align-items: flex-start; gap: var(--s-sp-1); }
  .mdns-muted { color: var(--s-ink-3); }
  .reachable-row { display: flex; align-items: center; gap: var(--s-sp-2); margin-bottom: var(--s-sp-3); }
  .lan-url-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s-sp-1); }
  .lan-url-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-2); padding: var(--s-sp-1) var(--s-sp-2); border: var(--s-hair) solid var(--s-line-soft); border-radius: 2px; background: var(--s-paper-deep); }
  .lan-url { font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); color: var(--s-ink-2); overflow-wrap: anywhere; }
  .copy-btn { flex-shrink: 0; background: none; border: var(--s-hair) solid var(--s-line-soft); border-radius: 2px; padding: 0.15rem 0.5rem; font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); letter-spacing: var(--s-track-label); color: var(--s-ink-2); cursor: pointer; }
  .copy-btn:hover { border-color: var(--s-ink-2); color: var(--s-ink); }
  .persona-editor { min-height: 26rem; resize: vertical; font-family: var(--s-font-mono) !important; font-size: var(--s-type-mark-sm) !important; background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper)) !important; border: var(--s-hair) solid var(--s-line-soft) !important; border-bottom: var(--s-hair) solid var(--s-line-soft) !important; border-radius: 2px !important; padding: var(--s-sp-3) !important; color: var(--s-ink-2) !important; }
  .unsaved-hint { font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-seal); }
  .card-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--s-sp-3); margin-top: var(--s-sp-3); }
  input[type="checkbox"] {
    appearance: none;
    width: 1rem; height: 1rem;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: none;
    flex-shrink: 0;
    position: relative;
    cursor: pointer;
  }
  input[type="checkbox"]:checked {
    background: var(--s-seal);
    border-color: var(--s-seal);
  }
  input[type="checkbox"]:checked::after {
    content: '';
    position: absolute; left: 2px; top: 1px;
    width: 8px; height: 5px;
    border: 1.4px solid white; border-top: 0; border-right: 0;
    transform: rotate(-45deg);
  }
  @media (max-width: 900px) { .settings-grid { grid-template-columns: 1fr; } }
  @media (max-width: 600px) { .persona-editor { min-height: 14rem; } }
</style>
