<script lang="ts">
  import { onMount } from 'svelte';

  interface UpdateStatus {
    inElectron: boolean;
    currentVersion: string | null;
    latestVersion: string | null;
    latestUrl: string | null;
    updateAvailable: boolean;
  }

  let status = $state<UpdateStatus | null>(null);
  let dismissed = $state(false);

  function dismissKey(version: string): string {
    return `openpalm.updateBanner.dismissed.${version}`;
  }

  onMount(async () => {
    try {
      const res = await fetch('/api/electron/update-status');
      if (!res.ok) return;
      const data = await res.json() as UpdateStatus;
      // Only render when running inside Electron AND an update is available.
      if (!data.inElectron || !data.updateAvailable || !data.latestVersion) return;
      // Honor per-version dismissal.
      if (typeof localStorage !== 'undefined') {
        if (localStorage.getItem(dismissKey(data.latestVersion))) return;
      }
      status = data;
    } catch {
      // Silently fail — banner is purely additive.
    }
  });

  function handleDismiss() {
    if (status?.latestVersion && typeof localStorage !== 'undefined') {
      localStorage.setItem(dismissKey(status.latestVersion), '1');
    }
    dismissed = true;
  }
</script>

{#if status && !dismissed}
  <div class="update-banner" role="status">
    <span class="update-banner-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    </span>
    <span class="update-banner-text">
      A new version of OpenPalm is available — <strong>v{status.latestVersion}</strong>
      {#if status.currentVersion}(you have v{status.currentVersion}){/if}
    </span>
    {#if status.latestUrl}
      <a href={status.latestUrl} target="_blank" rel="noopener noreferrer" class="update-banner-link">
        Download
      </a>
    {/if}
    <button type="button" class="update-banner-dismiss" aria-label="Dismiss" onclick={handleDismiss}>×</button>
  </div>
{/if}

<style>
  .update-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    background: #eef2ff;
    border-bottom: 1px solid #c7d2fe;
    color: #3730a3;
    font-size: var(--text-sm, 0.875rem);
  }
  .update-banner-icon { display: inline-flex; }
  .update-banner-text { flex: 1; }
  .update-banner-link {
    color: #4338ca;
    font-weight: 600;
    text-decoration: none;
  }
  .update-banner-link:hover { text-decoration: underline; }
  .update-banner-dismiss {
    background: transparent;
    border: 0;
    color: #3730a3;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 4px;
  }
  .update-banner-dismiss:hover { background: rgba(67, 56, 202, 0.08); }
</style>
