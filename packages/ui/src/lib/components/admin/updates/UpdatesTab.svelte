<script lang="ts">
  import type { ReleaseEntry, UiVersionEntry } from '$lib/api.js';
  import Spinner from '$lib/components/common/Spinner.svelte';

  interface Props {
    currentImageTag: string;
    selectedImageTag: string;
    tagChangeLoading: boolean;
    anyDangerousLoading: boolean;
    tokenStored: boolean;
    upgradeLoading: boolean;
    inElectron: boolean;
    /** Running @openpalm/ui version (the build currently serving this page). */
    uiVersion: string;
    uiVersions: UiVersionEntry[];
    uiVersionsLoading: boolean;
    selectedUiTag: string;
    uiDownloadLoading: boolean;
    uiDownloadReady: boolean;
    releases: ReleaseEntry[];
    releasesLoading: boolean;
    onSetImageTag: (tag: string) => void;
    onSelectedImageTagChange: (tag: string) => void;
    onUpgradeStack: () => void;
    onSelectedUiTagChange: (tag: string) => void;
    onDownloadUiVersion: (tag: string) => void;
    onRestartApp: () => void;
    onRefreshReleases: () => void;
  }

  let {
    currentImageTag,
    selectedImageTag,
    tagChangeLoading,
    anyDangerousLoading,
    tokenStored,
    upgradeLoading,
    inElectron,
    uiVersion,
    uiVersions,
    uiVersionsLoading,
    selectedUiTag,
    uiDownloadLoading,
    uiDownloadReady,
    releases,
    releasesLoading,
    onSetImageTag,
    onSelectedImageTagChange,
    onUpgradeStack,
    onSelectedUiTagChange,
    onDownloadUiVersion,
    onRestartApp,
    onRefreshReleases,
  }: Props = $props();

  function uiVersionLabel(v: UiVersionEntry): string {
    const tags: string[] = [];
    if (v.distTag) tags.push(v.distTag);
    else if (v.prerelease) tags.push('pre-release');
    return tags.length ? `${v.version} (${tags.join(', ')})` : v.version;
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Updates</h2>
      <p class="panel-subtitle">Pull new stack images, upgrade to the latest release, and update the UI.</p>
    </div>
    <button
      class="btn btn-sm btn-secondary refresh-releases"
      onclick={onRefreshReleases}
      disabled={releasesLoading || uiVersionsLoading}
      title="Re-fetch the release list from GitHub and npm"
    >
      {#if releasesLoading || uiVersionsLoading}
        <Spinner /> Refreshing…
      {:else}
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        Refresh releases
      {/if}
    </button>
  </div>
  <div class="panel-body">

    <!-- Stack images -->
    <div class="version-section">
      <div class="version-row">
        <span class="version-label">Stack images</span>
        <code class="version-value">{currentImageTag || '—'}</code>
      </div>
      <div class="version-input-row">
        {#if releasesLoading}
          <div class="version-select-skeleton"></div>
        {:else if releases.length > 0}
          <select
            class="version-select"
            value={selectedImageTag}
            onchange={(e) => onSelectedImageTagChange((e.currentTarget as HTMLSelectElement).value)}
            disabled={tagChangeLoading || anyDangerousLoading}
          >
            <option value="latest">latest</option>
            {#each releases as r (r.tag)}
              <option value={r.tag}>{r.tag}{r.prerelease ? ' (pre-release)' : ''}</option>
            {/each}
          </select>
        {:else}
          <input
            class="version-input"
            type="text"
            placeholder="e.g. 0.11.0 or latest"
            value={selectedImageTag}
            oninput={(e) => onSelectedImageTagChange((e.currentTarget as HTMLInputElement).value)}
            disabled={tagChangeLoading || anyDangerousLoading}
          />
        {/if}
        <button
          class="btn btn-sm btn-primary"
          onclick={() => { if (selectedImageTag.trim()) onSetImageTag(selectedImageTag.trim()); }}
          disabled={!selectedImageTag.trim() || tagChangeLoading || anyDangerousLoading}
        >
          {#if tagChangeLoading}
            <Spinner /> Applying…
          {:else}
            Pull &amp; Restart
          {/if}
        </button>
      </div>
      <p class="version-hint">Pulls the selected images and restarts services.</p>
    </div>

    <div class="version-divider"></div>

    <!-- Upgrade Stack -->
    <div class="version-section">
      <div class="version-row">
        <span class="version-label">Upgrade Stack</span>
      </div>
      <div class="version-input-row">
        <button
          class="btn btn-sm btn-secondary"
          onclick={onUpgradeStack}
          disabled={anyDangerousLoading || !tokenStored}
        >
          {#if upgradeLoading}
            <Spinner /> Upgrading…
          {:else}
            Upgrade to Latest
          {/if}
        </button>
      </div>
      <p class="version-hint">Downloads the latest assets, pulls images, and restarts services. Backs up current config first.</p>
    </div>

    <!-- UI build -->
    <div class="version-divider"></div>
    <div class="version-section">
      <div class="version-row">
        <span class="version-label">UI Version</span>
        <code class="version-value">{uiVersion || '—'}</code>
      </div>
      {#if inElectron}
        <div class="version-input-row">
          {#if uiVersionsLoading}
            <div class="version-select-skeleton"></div>
          {:else if uiVersions.length > 0}
            <select
              class="version-select"
              value={selectedUiTag}
              onchange={(e) => onSelectedUiTagChange((e.currentTarget as HTMLSelectElement).value)}
              disabled={uiDownloadLoading}
            >
              {#each uiVersions as v (v.version)}
                <option value={v.version}>{uiVersionLabel(v)}</option>
              {/each}
            </select>
          {:else}
            <input
              class="version-input"
              type="text"
              placeholder="e.g. 0.11.0-beta.7"
              value={selectedUiTag}
              oninput={(e) => onSelectedUiTagChange((e.currentTarget as HTMLInputElement).value)}
              disabled={uiDownloadLoading}
            />
          {/if}
          <button
            class="btn btn-sm"
            onclick={() => { if (selectedUiTag.trim()) onDownloadUiVersion(selectedUiTag.trim()); }}
            disabled={!selectedUiTag.trim() || uiDownloadLoading}
          >
            {#if uiDownloadLoading}
              <Spinner /> Downloading…
            {:else}
              Download
            {/if}
          </button>
        </div>
        {#if uiDownloadReady}
          <div class="version-restart-prompt">
            UI updated.
            <button class="btn btn-sm btn-primary" onclick={onRestartApp}>Restart App</button>
          </div>
        {:else}
          <p class="version-hint">Downloads and replaces the UI from GitHub. Takes effect on restart.</p>
        {/if}
      {/if}
    </div>

  </div>
</div>

<style>
  .panel-subtitle {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: var(--space-1) 0 0;
  }

  .refresh-releases {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }
  .refresh-releases svg {
    flex-shrink: 0;
  }

  .version-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .version-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .version-label {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .version-value {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    background: var(--color-bg-secondary);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
  }

  .version-input-row {
    display: flex;
    gap: var(--space-2);
  }

  .version-input {
    flex: 1;
    min-width: 0;
    padding: var(--space-1-5) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
  }

  .version-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .version-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    margin: 0;
    line-height: 1.5;
  }

  .version-divider {
    height: 1px;
    background: var(--color-border);
    margin: var(--space-3) 0;
  }

  .version-restart-prompt {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-success);
    padding: var(--space-2) var(--space-3);
    background: var(--color-success-bg);
    border-radius: var(--radius-md);
  }

  .version-select {
    flex: 1;
    min-width: 0;
    padding: var(--space-1-5) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
  }

  .version-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .version-select-skeleton {
    flex: 1;
    height: 34px;
    border-radius: var(--radius-md);
    background: linear-gradient(
      90deg,
      var(--color-bg-secondary) 25%,
      var(--color-bg-tertiary) 50%,
      var(--color-bg-secondary) 75%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
  }

  @keyframes skeleton-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
