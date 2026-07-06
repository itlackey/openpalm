<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { fetchAssistantSettings, saveAssistantSettings } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';

  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let projectName = $state('openpalm');
  let lanExposureEnabled = $state(false);
  let personaPath = $state('config/assistant/persona.md');
  let stackEnvPath = $state('knowledge/env/stack.env');
  let personaContent = $state('');
  // Snapshot of last-saved persona content for dirty detection.
  let savedPersonaContent = $state('');

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const data = await fetchAssistantSettings();
      projectName = data.projectName;
      lanExposureEnabled = data.lanExposureEnabled;
      personaPath = data.personaPath;
      stackEnvPath = data.stackEnvPath;
      personaContent = data.personaContent;
      savedPersonaContent = data.personaContent;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load assistant settings.';
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<void> {
    saving = true;
    error = '';
    try {
      const data = await saveAssistantSettings({ projectName, lanExposureEnabled, personaContent });
      projectName = data.projectName;
      lanExposureEnabled = data.lanExposureEnabled;
      personaContent = data.personaContent;
      savedPersonaContent = data.personaContent;
      notifications.push(
        'success',
        data.projectRenamed
          ? 'Assistant settings saved. Project name changed — run `openpalm restart` (or `openpalm update`) to move the whole stack to the new project name.'
          : 'Assistant settings saved. Restart the assistant container to apply them.',
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save assistant settings.';
      error = msg;
      notifications.push('error', msg);
    } finally {
      saving = false;
    }
  }

  let isDirty = $derived(personaContent !== savedPersonaContent);

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
      {#if isDirty}
        <span class="unsaved-hint" aria-live="polite">Unsaved changes</span>
      {/if}
      <button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving || !isDirty}>
        {#if saving}<Spinner />{/if}
        Save
      </button>
    </div>
  </div>

  {#if error}<div class="error-banner"><span>{error}</span></div>{/if}

  <div class="settings-grid">
    <section class="settings-card">
      <h3>Compose Project Name</h3>
      <p class="section-note">This writes <code>OP_PROJECT_NAME</code> in <code>{stackEnvPath}</code>. If unset, OpenPalm defaults to <code>openpalm</code>.</p>
      <label class="field" for="project-name">
        <span>Project name</span>
        <input id="project-name" class="control-input mono" type="text" spellcheck="false" placeholder="openpalm" bind:value={projectName} disabled={loading || saving} />
      </label>
      <p class="field-hint">Lowercase letters, numbers, dashes, and underscores only. This affects Docker Compose naming and collision detection.</p>
    </section>

    <section class="settings-card">
      <h3>LAN Exposure</h3>
      <p class="section-note">This writes <code>OP_ASSISTANT_BIND_ADDRESS</code> in <code>{stackEnvPath}</code>.</p>
      <label class="field-inline" for="assistant-lan-exposure">
        <input id="assistant-lan-exposure" type="checkbox" bind:checked={lanExposureEnabled} disabled={loading || saving} />
        <span>Expose the assistant OpenCode server on the host LAN</span>
      </label>
      <p class="field-hint">Off keeps the host bind on <code>127.0.0.1</code>. On switches it to <code>0.0.0.0</code> so other devices on your LAN can reach the host port.</p>
    </section>

    <section class="settings-card">
      <h3>Persona</h3>
      <p class="section-note">Edit the assistant persona markdown mounted into the assistant OpenCode instance.</p>
      <div class="path-chip">{personaPath}</div>
      <textarea class="control-input persona-editor mono" rows="20" spellcheck="false" bind:value={personaContent} disabled={loading || saving}></textarea>
    </section>
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
  .persona-editor { min-height: 26rem; resize: vertical; font-family: var(--s-font-mono) !important; font-size: var(--s-type-mark-sm) !important; background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper)) !important; border: var(--s-hair) solid var(--s-line-soft) !important; border-bottom: var(--s-hair) solid var(--s-line-soft) !important; border-radius: 2px !important; padding: var(--s-sp-3) !important; color: var(--s-ink-2) !important; }
  .unsaved-hint { font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-seal); }
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
