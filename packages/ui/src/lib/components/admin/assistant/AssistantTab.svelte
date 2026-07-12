<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '@openpalm/ui-kit/components/common/Spinner.svelte';
  import {
    fetchAssistantPersona,
    fetchHostStackSettings,
    saveAssistantPersona,
    saveHostStackSettings,
    type MdnsSurface,
  } from '$lib/api.js';
  import { hasCapability } from '$lib/runtime-context.svelte.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import { NETWORK_PRESET_LABELS, type NetworkAccessPreset } from '@openpalm/lib/control-plane/network-preset.js';

  // Phase 4 split (plan ui-runtime-modes-plan.md §5.F, Phase 4 step 2): host
  // STACK settings (project name, bind address → /api/host/stack) are a
  // separate concern from ASSISTANT settings (persona → /api/assistant/persona)
  // with separate capabilities, endpoints, and save actions. hasCapability()
  // is UX only — both endpoints enforce their capability server-side.

  let loading = $state(false);
  let error = $state('');

  // ── Host stack settings (host:stack:write) ─────────────────────────────────
  let stackSaving = $state(false);
  let projectName = $state('openpalm');
  let lanExposureEnabled = $state(false);
  let stackEnvPath = $state('knowledge/env/stack.env');
  let mdns: MdnsSurface | null = $state(null);
  // #563 — read-only preset surfacing (D8); null = custom/hand-tuned.
  let networkPreset: NetworkAccessPreset | null = $state(null);
  const networkPresetLabel = $derived(networkPreset ? NETWORK_PRESET_LABELS[networkPreset] : 'Custom (hand-configured)');

  // ── Assistant persona (assistant-settings:write) ───────────────────────────
  let personaSaving = $state(false);
  let personaPath = $state('config/assistant/persona.md');
  let personaContent = $state('');
  // Snapshot of last-saved persona content for dirty detection.
  let savedPersonaContent = $state('');

  const showStack = hasCapability('host:stack:read');
  const canEditStack = hasCapability('host:stack:write');
  const showPersona = hasCapability('assistant-settings:read');
  const canEditPersona = hasCapability('assistant-settings:write');

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      if (showStack) {
        const stack = await fetchHostStackSettings();
        projectName = stack.projectName;
        lanExposureEnabled = stack.lanExposureEnabled;
        stackEnvPath = stack.stackEnvPath;
        mdns = stack.mdns;
        networkPreset = stack.networkPreset;
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
      const data = await saveHostStackSettings({ projectName, lanExposureEnabled });
      projectName = data.projectName;
      lanExposureEnabled = data.lanExposureEnabled;
      mdns = data.mdns;
      networkPreset = data.networkPreset;
      notifications.push(
        'success',
        data.projectRenamed
          ? 'Stack settings saved. Project name changed — run `openpalm restart` (or `openpalm update`) to move the whole stack to the new project name.'
          : 'Stack settings saved. Restart the assistant container to apply them.',
      );
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
        <h3>LAN Exposure</h3>
        <p class="section-note">This writes <code>OP_ASSISTANT_BIND_ADDRESS</code> in <code>{stackEnvPath}</code>.</p>
        <div class="path-chip">Network access preset: {networkPresetLabel}</div>
        <p class="field-hint">Presets (This PC only / Home network / Shared network) are chosen in Setup — rerun the wizard from the dashboard to switch. The checkbox below is the advanced raw <code>OP_ASSISTANT_BIND_ADDRESS</code> override.</p>
        <label class="field-inline" for="assistant-lan-exposure">
          <input id="assistant-lan-exposure" type="checkbox" bind:checked={lanExposureEnabled} disabled={loading || saving || !canEditStack} />
          <span>Expose the assistant OpenCode server on the host LAN</span>
        </label>
        <p class="field-hint">Off keeps the host bind on <code>127.0.0.1</code>. On switches it to <code>0.0.0.0</code> so other devices on your LAN can reach the host port.</p>
        {#if mdns}
          <div class="path-chip mdns-chip">
            {#if mdns.assistant.advertised}
              <span>Assistant: <a href={`http://${mdns.assistant.name}:${mdns.assistant.port}`}>http://{mdns.assistant.name}:{mdns.assistant.port}</a></span>
            {:else}
              <span class="mdns-muted">Assistant: {mdns.assistant.name}:{mdns.assistant.port} (off — enable LAN exposure)</span>
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
  .field-inline { display: flex; align-items: center; gap: var(--s-sp-2); font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }
  .control-input { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); background: none; border: 0; border-bottom: var(--s-hair) solid var(--s-line); border-radius: 0; padding: 0.5rem 0; width: 100%; }
  .control-input:focus { outline: none; border-bottom-color: var(--s-ink-2); }
  .mono { font-family: var(--s-font-mono); font-size: var(--s-type-mark); }
  .field-hint { margin: var(--s-sp-2) 0 0; font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-3); }
  .path-chip { display: inline-flex; align-items: center; margin-bottom: var(--s-sp-3); padding: var(--s-sp-1) var(--s-sp-2); border-radius: 2px; border: var(--s-hair) solid var(--s-line-soft); background: var(--s-paper-deep); color: var(--s-ink-3); font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); letter-spacing: var(--s-track-label); }
  .mdns-chip { flex-direction: column; align-items: flex-start; gap: var(--s-sp-1); }
  .mdns-muted { color: var(--s-ink-3); }
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
