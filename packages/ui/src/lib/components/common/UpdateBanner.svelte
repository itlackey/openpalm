<script lang="ts">
  import { onMount } from 'svelte';
  import IconDownload from '../icons/IconDownload.svelte';

  // Full-application update surface (#572). This reads `window.openpalm.updater`,
  // which only the desktop shell exposes — served in a browser (CLI/container),
  // the object is absent and the banner never renders. Update state is PUSHED
  // from the main process, so download progress is live rather than polled.
  //
  // Discovery never downloads: the "Download" button below is the consent step.
  // Once a download completes the update also installs on an ordinary quit, so
  // "Restart and update" is a shortcut, not the only way to apply it.

  let updateState = $state<UpdaterState | null>(null);
  let dismissed = $state(false);
  let busy = $state(false);

  function dismissKey(version: string): string {
    return `openpalm.updateBanner.dismissed.${version}`;
  }

  /**
   * The phase a version's banner was dismissed in, or null. A dismissal
   * suppresses ONLY that phase: dismissing the "available" prompt must not
   * also swallow the later "ready to install" prompt for the same version,
   * which offers a different and more consequential action (the in-app
   * "Restart and update" would otherwise never appear again). Values written
   * before this fix are a bare '1', which reads as a dismissed "available".
   */
  function dismissedStatus(version: string): string | null {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(dismissKey(version));
    return raw === '1' ? 'available' : raw;
  }

  onMount(() => {
    const updater = window.openpalm?.updater;
    if (!updater) return;

    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        updateState = await updater.state();
        unsubscribe = updater.onState((next) => {
          updateState = next;
        });
      } catch {
        // Purely additive surface — never break the app over it.
      }
    })();
    return () => unsubscribe?.();
  });

  // Hidden until there is something to act on. `unsupported` (macOS, and any
  // unpackaged run) never reaches an actionable state — those installs update
  // by downloading a new build from the releases page.
  const visible = $derived(
    !!updateState &&
      !dismissed &&
      (updateState.status === 'available' ||
        updateState.status === 'downloading' ||
        updateState.status === 'downloaded'),
  );

  function handleDismiss() {
    if (updateState?.availableVersion && typeof localStorage !== 'undefined') {
      localStorage.setItem(dismissKey(updateState.availableVersion), updateState.status);
    }
    dismissed = true;
  }

  async function handleDownload() {
    if (busy) return;
    busy = true;
    try {
      updateState = (await window.openpalm?.updater?.download()) ?? updateState;
    } finally {
      busy = false;
    }
  }

  async function handleRestart() {
    if (busy) return;
    busy = true;
    try {
      await window.openpalm?.updater?.quitAndInstall();
    } finally {
      busy = false;
    }
  }

  // Suppress a banner the user already dismissed for this exact version AND
  // phase. Review E6: `dismissed` used to be a one-way boolean, so dismissing
  // version X also suppressed a LATER version Y for the rest of the session.
  // Re-derive it from the CURRENT version+status on every pushed state, so
  // neither a new version nor a new phase of the same version stays hidden
  // behind an older dismissal (see {@link dismissedStatus}).
  $effect(() => {
    const version = updateState?.availableVersion;
    const status = updateState?.status;
    if (!version || !status) return;
    dismissed = dismissedStatus(version) === status;
  });
</script>

{#if visible && updateState}
  <div class="update-banner" role="status">
    <span class="update-banner-icon" aria-hidden="true">
      <IconDownload size={16} />
    </span>

    {#if updateState.status === 'available'}
      <span class="update-banner-text">
        A new version of OpenPalm is available — <strong>v{updateState.availableVersion}</strong>
        (you have v{updateState.currentVersion})
      </span>
      <button type="button" class="update-banner-action" onclick={handleDownload} disabled={busy}>
        Download
      </button>
    {:else if updateState.status === 'downloading'}
      <span class="update-banner-text">
        Downloading v{updateState.availableVersion}{#if updateState.percent !== null}
          — {Math.round(updateState.percent)}%{/if}
      </span>
    {:else if updateState.status === 'downloaded'}
      <span class="update-banner-text">
        OpenPalm <strong>v{updateState.availableVersion}</strong> is ready to install
      </span>
      <button type="button" class="update-banner-action" onclick={handleRestart} disabled={busy}>
        Restart and update
      </button>
    {/if}

    {#if updateState.status !== 'downloading'}
      <button
        type="button"
        class="update-banner-dismiss"
        aria-label="Dismiss"
        onclick={handleDismiss}>×</button
      >
    {/if}
  </div>
{/if}

<style>
  .update-banner {
    display: flex;
    align-items: center;
    gap: var(--s-sp-3);
    padding: var(--s-sp-2) var(--s-sp-4);
    border-top: 1px solid var(--s-line-soft);
    border-bottom: 1px solid var(--s-line-soft);
    background: none;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
  }
  .update-banner-icon {
    display: inline-flex;
    color: var(--s-seal);
    flex-shrink: 0;
  }
  .update-banner-text { flex: 1; }
  .update-banner-action {
    background: none;
    border: 0;
    cursor: pointer;
    color: var(--s-seal);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    border-bottom: var(--s-hair) solid var(--s-seal);
    transition: opacity var(--s-t-quick) var(--s-ease);
  }
  .update-banner-action:hover:not(:disabled) { opacity: 0.7; }
  .update-banner-action:disabled { cursor: default; opacity: 0.5; }
  .update-banner-dismiss {
    background: none;
    border: 0;
    color: var(--s-ink-3);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: var(--s-sp-1) var(--s-sp-2);
    border-radius: 2px;
    transition: color var(--s-t-quick) var(--s-ease);
  }
  .update-banner-dismiss:hover { color: var(--s-ink); }
</style>
