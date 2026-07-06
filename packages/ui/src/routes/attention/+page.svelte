<script lang="ts">
  // /attention — the migration/blocking surface split out of /splash (plan
  // ui-runtime-modes-plan.md §6.5, Phase 3). resolveLanding() routes
  // host-capable sessions here when a blocking task (migration.status ===
  // 'pending') must finish before the stack can continue. Nothing produces
  // 'pending' yet — the surface is wired ahead of the first blocking OP_HOME
  // migration; sessions that land here with nothing blocking are redirected
  // back to the resolved landing by the hooks.server launch-routing guard.
  import { resolve } from '$app/paths';
  import IconLogo from '@openpalm/ui-kit/components/icons/IconLogo.svelte';
</script>

<svelte:head><title>OpenPalm — needs attention</title></svelte:head>

<div class="setup-page">
  <header class="wiz-topbar">
    <div class="wiz-wordmark">
      <IconLogo size={30} />
      <b>OpenPalm</b>
    </div>
  </header>

  <main class="attention-stage">
    <div class="attention-panel">
      <p class="wiz-eyebrow"><span class="sev-dot" aria-hidden="true"></span>Needs attention</p>
      <h1 class="wiz-title">Before your assistant can continue</h1>
      <p class="wiz-lede">
        A blocking task — such as a data migration — has to finish before OpenPalm can start
        normally. Follow the steps shown here, then reload.
      </p>

      <div class="attention-actions">
        <button class="btn btn-primary btn-lg" onclick={() => window.location.reload()}>Reload</button>
        <a class="btn btn-outline btn-lg" href={resolve('/host')}>Open dashboard</a>
      </div>
    </div>
  </main>
</div>

<style>
  /* Mirrors the calm single-column stage of the setup wizard (and the former
     /splash page): full-height page, wordmark topbar, big title + lede. */
  .attention-stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    overflow-y: auto;
    padding: clamp(var(--s-sp-8), 8vh, 3rem) var(--s-sp-6) 3rem;
    background: var(--s-paper);
    color: var(--s-ink);
    font-family: var(--s-font-display);
  }
  .attention-panel {
    width: 100%;
    max-width: 32rem;
  }

  .attention-panel .wiz-eyebrow {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
  }
  .sev-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
    background: var(--s-seal);
  }

  .attention-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-sp-3);
    margin-top: var(--s-sp-6);
  }

  @media (max-width: 480px) {
    .attention-stage { padding: var(--s-sp-6) var(--s-sp-4) var(--s-sp-8); }
    .wiz-topbar { padding-left: var(--s-sp-4); padding-right: var(--s-sp-4); }
    .btn { width: 100%; }
  }
</style>
