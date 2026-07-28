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
  import { createFocusTrap, handleTrapKeydown } from '$lib/actions/focus-trap.js';
  import { formatBytes, formatDate } from '$lib/format-date.js';
  import { resource, runAction, type ActionHandle } from '$lib/actions.svelte.js';

  // #499 backup state — load into a resource; the inline banner renders its error.
  const backupsRes = resource<BackupSummaryView>(fetchBackups, {
    fallback: 'Failed to load backups.',
  });
  let backups = $derived(backupsRes.data);
  let prunePromptKeep = $state<number | null>(null);
  let pruning = $state<ActionHandle<unknown> | null>(null);
  const managePruneFocus = createFocusTrap({ deferRestore: true });

  // #502 one-time secret-strip notice — fails soft to null (error unrendered).
  const secretNoticeRes = resource<{ keys: string[]; at: string } | null>(
    async () => (await fetchSecretStripNotice()).notice,
  );
  let secretNotice = $derived(secretNoticeRes.data);

  // #500 stuck-operation recovery — fails soft to null (error unrendered).
  const installLockRes = resource<InstallLockStatusView>(fetchInstallLockStatus);
  let installLock = $derived(installLockRes.data);
  let unlocking = $state<ActionHandle<{ removed: boolean }> | null>(null);
  let unlockCleared = $state(false);

  onMount(() => {
    void backupsRes.reload();
    void secretNoticeRes.reload();
    void installLockRes.reload();
  });

  async function onClearLock(): Promise<void> {
    const run = runAction(() => clearInstallLock(), { fallback: 'Failed to clear the lock.' });
    unlocking = run;
    const res = await run.result;
    if (res) unlockCleared = res.removed;
    await installLockRes.reload();
  }

  async function onDismissSecretNotice(): Promise<void> {
    secretNoticeRes.data = null;
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
    const run = runAction(() => pruneBackups(prunePromptKeep as number), {
      fallback: 'Failed to prune backups.',
    });
    pruning = run;
    const ok = (await run.result) !== undefined;
    if (ok) {
      prunePromptKeep = null;
      await backupsRes.reload();
    }
  }

</script>

<div class="panel" role="tabpanel" inert={prunePromptKeep !== null}>
  <div class="panel-header">
    <div>
      <h2>Recovery</h2>
      <p class="panel-subtitle">Backups · recovery · migration</p>
    </div>
  </div>

  <div class="panel-body">

    {#if secretNotice}
      <!-- #502: secret-looking keys were removed from stack.env. -->
      <div class="secret-notice" role="status">
        <div class="secret-notice-text">
          <p class="secret-notice-title">Secret-looking values were moved out of stack.env</p>
          <p>
            {secretNotice.keys.join(', ')} {secretNotice.keys.length === 1 ? 'was' : 'were'} moved
            to <strong>knowledge/secrets/</strong> because secrets don't belong in stack.env — the
            value{secretNotice.keys.length === 1 ? '' : 's'} were not deleted. Re-add
            {secretNotice.keys.length === 1 ? 'it' : 'them'} via the <strong>Connections</strong> tab
            if you'd rather manage {secretNotice.keys.length === 1 ? 'it' : 'them'} there.
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
        </div>
        <button
          class="btn btn-sm btn-primary"
          onclick={onClearLock}
          disabled={unlocking?.loading ?? false}
          aria-busy={unlocking?.loading ?? false}
        >
          {#if unlocking?.loading}<Spinner /> Clearing…{:else}Clear it{/if}
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
            disabled={(pruning?.loading ?? false) || backupsRes.loading}
          >Prune…</button>
        {/if}
      </div>
      <p class="backups-desc">
        Each update copies your settings here first. To restore, run
        <code>openpalm rollback</code> for the last update, or point OpenPalm at a snapshot directory manually.
        Nothing is ever deleted automatically.
      </p>

      {#if backupsRes.loading}
        <p class="backups-empty"><Spinner /> Loading backups…</p>
      {:else if backupsRes.error}
        <p class="backups-error" role="alert">Couldn't load backups: {backupsRes.error}</p>
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

    </section>

  </div>
</div>

{#if prunePromptKeep !== null}
  <div
    class="prune-prompt"
    role="alertdialog"
    aria-modal="true"
    aria-label="Confirm prune backups"
    tabindex="-1"
    onkeydown={(event) => handleTrapKeydown(event, cancelPrune)}
    {@attach managePruneFocus}
  >
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
      <button class="btn btn-sm btn-danger" onclick={confirmPrune} disabled={pruning?.loading ?? false}>
        {#if pruning?.loading}<Spinner /> Deleting…{:else}Delete older backups{/if}
      </button>
      <button class="btn btn-sm btn-secondary" onclick={cancelPrune} disabled={pruning?.loading ?? false}>Cancel</button>
    </div>
  </div>
{/if}

<style>
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
