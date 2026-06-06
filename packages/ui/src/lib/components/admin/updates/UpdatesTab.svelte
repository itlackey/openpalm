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

  // Single spoken status for screen readers — covers every in-flight operation
  // on this screen so AT users get feedback for actions that restart services.
  const statusText = $derived(
    upgradeLoading
      ? 'Updating OpenPalm to the latest version…'
      : tagChangeLoading
        ? 'Installing the selected version and restarting…'
        : uiDownloadLoading
          ? 'Downloading the admin interface…'
          : releasesLoading || uiVersionsLoading
            ? 'Checking for updates…'
            : ''
  );
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Check-up</h2>
      <p class="panel-subtitle">Keep OpenPalm up to date. An update backs up your settings first, then briefly restarts your assistant.</p>
    </div>
    <button
      class="btn btn-sm btn-secondary refresh-releases"
      onclick={onRefreshReleases}
      disabled={releasesLoading || uiVersionsLoading}
      aria-busy={releasesLoading || uiVersionsLoading}
      title="Check GitHub for newer versions"
    >
      {#if releasesLoading || uiVersionsLoading}
        <Spinner /> Checking…
      {:else}
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        Check for updates
      {/if}
    </button>
  </div>

  <!-- Polite status region: announces in-flight operations to assistive tech. -->
  <p class="status-live" role="status" aria-live="polite">{statusText}</p>

  <div class="panel-body">

    <!-- Recommended one-click update (safe path: backs up config first). -->
    <section class="update-card" aria-labelledby="update-primary-title">
      <div class="update-card-text">
        <h3 id="update-primary-title" class="update-title">Update to the latest version</h3>
        <p class="update-desc">
          Downloads and installs the newest OpenPalm release. Your settings are backed up first,
          then your assistant restarts — it will be offline for about a minute. Your data is kept.
        </p>
      </div>
      <button
        class="btn btn-primary update-go"
        onclick={onUpgradeStack}
        disabled={anyDangerousLoading || !tokenStored}
        aria-busy={upgradeLoading}
      >
        {#if upgradeLoading}
          <Spinner /> Updating…
        {:else}
          Update now
        {/if}
      </button>
    </section>

    <!-- Current versions (informational, not actions). -->
    <dl class="versions">
      <div class="versions-row">
        <dt>OpenPalm</dt>
        <dd><code class="version-value">{currentImageTag || '—'}</code></dd>
      </div>
      <div class="versions-row">
        <dt>Admin interface</dt>
        <dd><code class="version-value">{uiVersion || '—'}</code></dd>
      </div>
    </dl>

    <!-- Advanced: pin a specific version (rollback / troubleshooting). -->
    <details class="advanced">
      <summary>Advanced options</summary>
      <div class="advanced-body">

        <div class="version-section">
          <label class="version-label" for="stack-version-select">Install a specific version</label>
          <div class="version-input-row">
            {#if releasesLoading}
              <div class="version-select-skeleton"></div>
            {:else if releases.length > 0}
              <select
                id="stack-version-select"
                class="version-select"
                aria-label="OpenPalm version to install"
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
                id="stack-version-select"
                class="version-input"
                type="text"
                aria-label="OpenPalm version to install"
                placeholder="e.g. 0.11.0 or latest"
                value={selectedImageTag}
                oninput={(e) => onSelectedImageTagChange((e.currentTarget as HTMLInputElement).value)}
                disabled={tagChangeLoading || anyDangerousLoading}
              />
            {/if}
            <button
              class="btn btn-sm btn-secondary"
              onclick={() => { if (selectedImageTag.trim()) onSetImageTag(selectedImageTag.trim()); }}
              disabled={!selectedImageTag.trim() || tagChangeLoading || anyDangerousLoading}
              aria-busy={tagChangeLoading}
            >
              {#if tagChangeLoading}
                <Spinner /> Installing…
              {:else}
                Install &amp; restart
              {/if}
            </button>
          </div>
          <p class="version-hint">For rollback or troubleshooting. Installs the chosen version and restarts services (about a minute offline).</p>
        </div>

        {#if inElectron}
          <div class="version-divider"></div>
          <div class="version-section">
            <label class="version-label" for="ui-version-select">Admin interface version</label>
            <div class="version-input-row">
              {#if uiVersionsLoading}
                <div class="version-select-skeleton"></div>
              {:else if uiVersions.length > 0}
                <select
                  id="ui-version-select"
                  class="version-select"
                  aria-label="Admin interface version to download"
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
                  id="ui-version-select"
                  class="version-input"
                  type="text"
                  aria-label="Admin interface version to download"
                  placeholder="e.g. 0.11.0-beta.7"
                  value={selectedUiTag}
                  oninput={(e) => onSelectedUiTagChange((e.currentTarget as HTMLInputElement).value)}
                  disabled={uiDownloadLoading}
                />
              {/if}
              <button
                class="btn btn-sm btn-secondary"
                onclick={() => { if (selectedUiTag.trim()) onDownloadUiVersion(selectedUiTag.trim()); }}
                disabled={!selectedUiTag.trim() || uiDownloadLoading}
                aria-busy={uiDownloadLoading}
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
                Admin interface updated.
                <button class="btn btn-sm btn-primary" onclick={onRestartApp}>Restart app</button>
              </div>
            {:else}
              <p class="version-hint">Downloads and replaces the admin interface. Takes effect after restart.</p>
            {/if}
          </div>
        {/if}

      </div>
    </details>

  </div>
</div>

<style>
  .panel-subtitle {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: var(--space-1) 0 0;
    max-width: 60ch;
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
  /* Once the header wraps, separate the button from the subtitle above it so it
     reads as an action, not a third line of text. */
  @media (max-width: 600px) {
    .refresh-releases {
      margin-top: var(--space-2);
    }
  }

  /* Visually hidden, still announced by screen readers. */
  .status-live {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* ── Recommended update card ── */
  .update-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-bg-secondary);
  }
  .update-card-text {
    flex: 1;
    min-width: 14rem;
  }
  .update-title {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin: 0;
  }
  .update-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: var(--space-1) 0 0;
    line-height: 1.5;
    max-width: 60ch;
  }
  .update-go {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* ── Current versions ── */
  .versions {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: var(--space-5) 0 0;
  }
  .versions-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .versions-row dt {
    font-size: var(--text-sm);
    color: var(--color-text);
  }
  .versions-row dd {
    margin: 0;
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

  /* ── Advanced disclosure ── */
  .advanced {
    margin-top: var(--space-5);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-4);
  }
  .advanced > summary {
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
    list-style: revert;
  }
  .advanced > summary:hover {
    color: var(--color-text);
  }
  .advanced > summary:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  .version-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .version-label {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .version-input-row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
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

  /* Secondary (not tertiary) for AA contrast in light theme. */
  .version-hint {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
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

  @media (prefers-reduced-motion: reduce) {
    .version-select-skeleton { animation: none; }
  }
</style>
