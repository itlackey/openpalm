<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { fetchAssistantSettings, saveAssistantSettings } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';

  interface Props { tokenStored: boolean; }
  let { tokenStored }: Props = $props();

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
      notifications.push('success', 'Assistant settings saved. Restart the assistant container to apply them.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save assistant settings.';
      error = msg;
      notifications.push('error', msg);
    } finally {
      saving = false;
    }
  }

  let isDirty = $derived(personaContent !== savedPersonaContent);

  onMount(() => { if (tokenStored) void load(); });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Assistant</h2>
      <p class="panel-subtitle">Configure the Docker Compose project name in <code>{stackEnvPath}</code> and edit the assistant persona file mounted from <code>{personaPath}</code>.</p>
    </div>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving || !tokenStored}>
        {#if loading}<Spinner />{/if}
        Refresh
      </button>
      {#if isDirty}
        <span class="unsaved-hint" aria-live="polite">Unsaved changes</span>
      {/if}
      <button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving || !tokenStored || !isDirty}>
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
  .panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); flex-wrap: wrap; }
  .panel-subtitle { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--color-text-secondary); max-width: 72ch; }
  .panel-header-actions { display: flex; gap: var(--space-2); }
  .error-banner { background: var(--color-danger-subtle, rgba(239,68,68,0.1)); color: var(--color-danger, #ef4444); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); margin-bottom: var(--space-4); }
  .settings-grid { display: grid; grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr); gap: var(--space-4); align-items: start; }
  .settings-card { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-4); background: var(--color-bg-secondary); }
  .settings-card h3 { margin: 0 0 var(--space-2); font-size: var(--text-base); color: var(--color-text); }
  .section-note { margin: 0 0 var(--space-3); font-size: var(--text-sm); color: var(--color-text-secondary); }
  .field { display: grid; gap: var(--space-1); font-size: var(--text-sm); color: var(--color-text-secondary); }
  .field-inline { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--color-text); }
  .control-input { font-size: var(--text-sm); color: var(--color-text); background: var(--color-input-bg, var(--color-bg)); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); width: 100%; }
  .control-input:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }
  .mono { font-family: var(--font-mono); }
  .field-hint { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--color-text-secondary); }
  .path-chip { display: inline-flex; align-items: center; margin-bottom: var(--space-3); padding: var(--space-1) var(--space-2); border-radius: 999px; background: var(--color-bg-tertiary, var(--color-bg)); color: var(--color-text-secondary); font-size: var(--text-xs); font-family: var(--font-mono); }
  .persona-editor { min-height: 26rem; resize: vertical; }
  .unsaved-hint { font-size: var(--text-xs); color: var(--color-warning); font-weight: var(--font-medium); }
  @media (max-width: 900px) { .settings-grid { grid-template-columns: 1fr; } .persona-editor { min-height: 18rem; } }
</style>
