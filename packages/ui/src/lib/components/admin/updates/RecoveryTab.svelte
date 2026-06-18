<script lang="ts">
  import { onMount } from 'svelte';
  import type { BackupSummaryView } from '$lib/api.js';
  import {
    fetchBackups,
    pruneBackups,
    fetchSecretStripNotice,
    dismissSecretStripNotice as apiDismissSecretStripNotice,
    fetchInstallLockStatus,
    clearInstallLock,
    type InstallLockStatusView,
  } from '$lib/api.js';
  import Spinner from '$lib/components/common/Spinner.svelte';

  // #499 backup state
  let backups = $state<BackupSummaryView | null>(null);
  let backupsLoading = $state(false);
  let backupsError = $state('');
  let prunePromptKeep = $state<number | null>(null);
  let pruning = $state(false);

  // #502 one-time secret-strip notice
  let secretNotice = $state<{ keys: string[]; at: string } | null>(null);

  // #500 stuck-operation recovery
  let installLock = $state<InstallLockStatusView | null>(null);
  let unlocking = $state(false);
  let unlockError = $state('');
  let unlockCleared = $state(false);

  onMount(() => {
    void loadBackups();
    void loadSecretNotice();
    void loadInstallLock();
  });

  async function loadInstallLock(): Promise<void> {
    try {
      installLock = await fetchInstallLockStatus();
    } catch {
      installLock = null;
    }
  }

  async function onClearLock(): Promise<void> {
    unlocking = true;
    unlockError = '';
    try {
      const res = await clearInstallLock();
      unlockCleared = res.removed;
      await loadInstallLock();
    } catch (e) {
      unlockError = e instanceof Error ? e.message : String(e);
      await loadInstallLock();
    } finally {
      unlocking = false;
    }
  }

  async function loadBackups(): Promise<void> {
    backupsLoading = true;
    backupsError = '';
    try {
      backups = await fetchBackups();
    } catch (e) {
      backupsError = e instanceof Error ? e.message : String(e);
    } finally {
      backupsLoading = false;
    }
  }

  async function loadSecretNotice(): Promise<void> {
    try {
      const res = await fetchSecretStripNotice();
      secretNotice = res.notice;
    } catch {
      secretNotice = null;
    }
  }

  async function onDismissSecretNotice(): Promise<void> {
    secretNotice = null;
    try {
      await apiDismissSecretStripNotice();
    } catch {
      /* best-effort; UI already hidden */
    }
  }

  function openPrunePrompt(): void {
    prunePromptKeep = backups && backups.count > 1 ? backups.count - 1 : 0;
  }
  function cancelPrune(): void {
    prunePromptKeep = null;
  }
  async function confirmPrune(): Promise<void> {
    if (prunePromptKeep === null) return;
    pruning = true;
    try {
      await pruneBackups(prunePromptKeep);
      prunePromptKeep = null;
      await loadBackups();
    } catch (e) {
      backupsError = e instanceof Error ? e.message : String(e);
    } finally {
      pruning = false;
    }
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Recovery</h2>
      <p class="panel-subtitle">Backups, lock recovery, and secret migration notices.</p>
    </div>
  </div>

  <div class="panel-body">

    {#if secretNotice}
      <!-- #502: secret-looking keys were removed from stack.env. -->
      <div class="secret-notice" role="status">
        <div class="secret-notice-text">
          <p class="secret-notice-title">Secret-looking values were removed from stack.env</p>
          <p>
            {secretNotice.keys.join(', ')} {secretNotice.keys.length === 1 ? 'was' : 'were'} removed
            because secrets don't belong in stack.env. Re-add {secretNotice.keys.length === 1 ? 'it' : 'them'}
            via the <strong>Connections</strong> tab (or as a secret) so your provider keeps working.
          </p>
        </div>
        <button class="btn btn-sm btn-secondary" onclick={onDismissSecretNotice}>Dismiss</button>
      </div>
    {/if}

    {#if installLock?.present && installLock.stale}
      <!-- #500: a previous install/upgrade left a stale lock. -->
      <div class="stuck-notice" role="status">
        <div class="stuck-notice-text">
          <p class="stuck-notice-title">An operation seems stuck</p>
          <p>
            A previous install or update didn't finish cleanly and left a lock behind. It would
            clear itself automatically after 30 minutes — or you can clear it now to run another
            update. Nothing else is changed.
          </p>
          {#if unlockError}
            <p class="stuck-notice-error" role="alert">{unlockError}</p>
          {/if}
        </div>
        <button class="btn btn-sm btn-primary" onclick={onClearLock} disabled={unlocking} aria-busy={unlocking}>
          {#if unlocking}<Spinner /> Clearing…{:else}Clear it{/if}
        </button>
      </div>
    {:else if unlockCleared}
      <div class="stuck-notice stuck-notice-ok" role="status">
        <div class="stuck-notice-text">
          <p class="stuck-notice-title">Cleared</p>
          <p>The stuck operation was cleared. You can run an update again.</p>
        </div>
      </div>
    {/if}

    <!-- #499: backups -->
    <section class="backups-section" aria-labelledby="backups-title">
      <div class="backups-header">
        <div>
          <h3 id="backups-title" class="backups-title">Backups</h3>
          {#if backups && backups.count > 0}
            <p class="backups-summary">
              {backups.count} {backups.count === 1 ? 'backup' : 'backups'} ·
              {formatBytes(backups.totalBytes)} total · last {formatDate(backups.lastBackupAt)}
            </p>
          {/if}
        </div>
        {#if backups && backups.count > 0}
          <button
            class="btn btn-sm btn-secondary"
            onclick={openPrunePrompt}
            disabled={pruning || backupsLoading}
          >Prune…</button>
        {/if}
      </div>
      <p class="backups-desc">
        Each update copies your settings here first. To restore, run
        <code>openpalm rollback</code> for the last update, or point OpenPalm at a snapshot directory manually.
        Nothing is ever deleted automatically.
      </p>

      {#if backupsLoading}
        <p class="backups-empty"><Spinner /> Loading backups…</p>
      {:else if backupsError}
        <p class="backups-error" role="alert">Couldn't load backups: {backupsError}</p>
      {:else if !backups || backups.count === 0}
        <p class="backups-empty">No backups yet — one is created the first time you update.</p>
      {:else}
        <table class="backups-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>Size</th>
              <th>Restore</th>
            </tr>
          </thead>
          <tbody>
            {#each backups.backups as b (b.path)}
              <tr>
                <td class="backups-cell-name" title={b.path}>{b.name}</td>
                <td class="backups-cell-meta">{formatDate(b.createdAt)}</td>
                <td class="backups-cell-meta">{formatBytes(b.sizeBytes)}</td>
                <td class="backups-cell-restore">
                  <span class="backups-restore-note" title="Run: openpalm rollback">
                    <code>openpalm rollback</code>
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if prunePromptKeep !== null}
        <div class="prune-prompt" role="alertdialog" aria-label="Confirm prune backups">
          <p class="prune-prompt-title">Delete older backups?</p>
          <p>
            Keep the newest
            <input
              class="prune-keep-input"
              type="number"
              min="0"
              max={backups?.count ?? 0}
              bind:value={prunePromptKeep}
              aria-label="Number of newest backups to keep"
            />
            and permanently delete the rest. This cannot be undone.
          </p>
          <div class="prune-actions">
            <button class="btn btn-sm btn-danger" onclick={confirmPrune} disabled={pruning}>
              {#if pruning}<Spinner /> Deleting…{:else}Delete older backups{/if}
            </button>
            <button class="btn btn-sm btn-secondary" onclick={cancelPrune} disabled={pruning}>Cancel</button>
          </div>
        </div>
      {/if}
    </section>

  </div>
</div>

<style>
  .panel-subtitle {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    margin: var(--s-sp-1) 0 0;
    max-width: 60ch;
  }

  /* #502 secret-strip notice */
  .secret-notice {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-sp-3);
    margin-bottom: var(--s-sp-3);
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
  }
  .secret-notice-text { min-width: 0; }
  .secret-notice-title {
    margin: 0 0 var(--s-sp-1) 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-seal);
  }
  .secret-notice p { margin: 0; font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }

  /* #500 stuck-operation recovery */
  .stuck-notice {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-sp-3);
    margin-bottom: var(--s-sp-3);
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
  }
  .stuck-notice-ok {
    border-color: var(--s-moss);
  }
  .stuck-notice-text { min-width: 0; }
  .stuck-notice-title {
    margin: 0 0 var(--s-sp-1) 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-seal);
  }
  .stuck-notice-ok .stuck-notice-title { color: var(--s-moss); }
  .stuck-notice p { margin: 0; font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }
  .stuck-notice-error { margin-top: var(--s-sp-1) !important; color: var(--s-seal); }

  /* #499 backups */
  .backups-section {
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper-deep);
  }
  .backups-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-sp-2);
    margin-bottom: var(--s-sp-2);
  }
  .backups-title {
    margin: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }
  .backups-summary {
    margin: var(--s-sp-1) 0 0 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
  }
  .backups-desc {
    margin: 0 0 var(--s-sp-3) 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
  }
  .backups-empty, .backups-error {
    margin: var(--s-sp-1) 0 0 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
  }
  .backups-error { color: var(--s-seal); }

  .backups-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
  }
  .backups-table th {
    text-align: left;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    padding: var(--s-sp-1) var(--s-sp-2);
    border-bottom: var(--s-hair) solid var(--s-line);
  }
  .backups-table td {
    padding: var(--s-sp-2);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    color: var(--s-ink);
    vertical-align: middle;
  }
  .backups-table tr:last-child td {
    border-bottom: none;
  }
  .backups-table tr:hover td {
    background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
  }
  .backups-cell-name {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 20rem;
    color: var(--s-ink-2);
  }
  .backups-cell-meta {
    white-space: nowrap;
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }
  .backups-cell-restore {
    white-space: nowrap;
  }
  .backups-restore-note {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    color: var(--s-ink-3);
  }

  .prune-prompt {
    margin-top: var(--s-sp-3);
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
  }
  .prune-prompt-title {
    margin: 0 0 var(--s-sp-1) 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-seal);
  }
  .prune-prompt p { margin: 0 0 var(--s-sp-2) 0; font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }
  .prune-keep-input {
    width: 4rem;
    padding: var(--s-sp-1) var(--s-sp-2);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
    color: var(--s-ink);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }
  .prune-actions { display: flex; gap: var(--s-sp-2); }
</style>
