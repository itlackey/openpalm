<script lang="ts">
  import type { PageData } from './$types';
  import { resolve } from '$app/paths';
  import IconLogo from '$lib/components/icons/IconLogo.svelte';

  let { data }: { data: PageData } = $props();

  type Severity = 'danger' | 'warning' | 'info' | 'success';

  const view = $derived({ state: data.launchStatus.local.state });

  function remoteLabel(s: string): string {
    return { accessible: 'Connected', unreachable: 'Unreachable', unauthorized: 'Needs sign-in', unknown: 'Unknown' }[s] ?? s;
  }

  // ── Per-stack-state copy ─────────────────────────────────────────────────────
  type Card = { severity: Severity; eyebrow: string; title: string; body: string };
  const stackCard = $derived.by<Card>(() => {
    switch (data.launchStatus.local.state) {
      case 'not_installed':
        return { severity: 'info', eyebrow: 'Welcome', title: 'Let’s get you set up',
          body: 'OpenPalm isn’t installed yet. Run the quick setup to install your assistant, or connect to one running somewhere else.' };
      case 'setup_incomplete':
        return { severity: 'warning', eyebrow: 'Almost there', title: 'Finish setting up',
          body: 'Installation was started but never finished. Pick up where you left off to get your assistant running.' };
      case 'installed_offline':
        return { severity: 'warning', eyebrow: 'Stopped', title: 'Your assistant is offline',
          body: 'OpenPalm is installed but nothing is running right now. Open the dashboard to start it back up.' };
      case 'installed_broken':
        return { severity: 'danger', eyebrow: 'Needs attention', title: 'Something needs a look',
          body: 'Your stack is running but one or more services are unhealthy. The diagnostics will show you what went wrong.' };
      case 'running':
        return { severity: 'success', eyebrow: 'Ready', title: 'You’re all set',
          body: 'Everything is healthy. Open the chat to start talking to your assistant.' };
      default:
        return { severity: 'info', eyebrow: 'Status', title: 'OpenPalm', body: '' };
    }
  });

  const runtime = $derived(data.launchStatus.local.runtime);
  const remotes = $derived(data.launchStatus.remotes);
  const accessibleRemote = $derived(remotes.find((r) => r.state === 'accessible'));
</script>

<svelte:head><title>OpenPalm</title></svelte:head>

<div class="setup-page">
  <header class="wiz-topbar">
    <div class="wiz-wordmark">
      <IconLogo size={30} />
      <b>OpenPalm</b>
    </div>
  </header>

  <main class="splash-stage">
    <div class="splash-panel">
      <p class="wiz-eyebrow"><span class="sev-dot sev-{stackCard.severity}" aria-hidden="true"></span>{stackCard.eyebrow}</p>
      <h1 class="wiz-title">{stackCard.title}</h1>
      <p class="wiz-lede">{stackCard.body}</p>

      {#if view.state === 'not_installed' && runtime && !runtime.dockerPresent}
        <p class="splash-guidance">No container runtime found. Install <a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noreferrer">Docker</a> (or OrbStack / Podman), start it, then reload this page.</p>
      {/if}
      {#if view.state === 'installed_broken'}
        <p class="splash-guidance">Unhealthy services are listed in Diagnostics; the container logs show the underlying error.</p>
      {/if}

      <div class="splash-actions">
        {#if view.state === 'not_installed'}
          <a class="btn btn-primary btn-lg" href={resolve('/setup')}>Run setup</a>
          {#if accessibleRemote}<a class="btn btn-outline btn-lg" href={resolve('/chat')}>Use {accessibleRemote.name}</a>
          {:else}<button class="btn btn-ghost btn-lg" onclick={() => window.location.reload()}>Reload</button>{/if}
        {:else if view.state === 'setup_incomplete'}
          <a class="btn btn-primary btn-lg" href={resolve('/setup')}>Resume setup</a>
        {:else if view.state === 'installed_offline'}
          <a class="btn btn-primary btn-lg" href={resolve('/admin')}>Open dashboard</a>
          <button class="btn btn-outline btn-lg" onclick={() => window.location.reload()}>Reload</button>
        {:else if view.state === 'installed_broken'}
          <a class="btn btn-primary btn-lg" href={resolve('/admin')}>Open diagnostics</a>
          <button class="btn btn-outline btn-lg" onclick={() => window.location.reload()}>Retry</button>
        {:else if view.state === 'running'}
          <a class="btn btn-primary btn-lg" href={resolve('/chat')}>Open chat</a>
          <a class="btn btn-ghost btn-lg" href={resolve('/admin')}>Admin</a>
        {/if}
      </div>

      {#if remotes.length}
        <ul class="splash-remotes" aria-label="Remote connections">
          {#each remotes as remote (remote.id)}
            <li>
              <span class="dot {remote.state === 'accessible' ? 'ok' : 'bad'}" aria-hidden="true"></span>
              <span class="rname">{remote.name}</span>
              <span class="rstate">{remoteLabel(remote.state)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </main>
</div>

<style>
  /* Calm, top-aligned single-column stage — mirrors the setup wizard's friendly,
     low-density feel (full-height page, wordmark topbar, big title + lede). Top
     aligned (not centred) so there is no empty band above the content, matching
     the wizard's content rhythm. */
  .splash-stage {
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
  .splash-panel {
    width: 100%;
    max-width: 32rem;
  }

  /* Severity eyebrow — mono label treatment matches the Stillness system. */
  .splash-panel .wiz-eyebrow {
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
    width: 7px; height: 7px; border-radius: 50%; flex: none;
  }
  .sev-dot.sev-danger  { background: var(--s-seal); }
  .sev-dot.sev-warning { background: color-mix(in srgb, var(--s-seal) 60%, var(--s-ink)); }
  .sev-dot.sev-info    { background: var(--s-ink-2); }
  .sev-dot.sev-success { background: var(--s-moss); }

  /* Single, controlled gap before the actions. */
  .splash-panel :global(.wiz-lede) { margin-bottom: var(--s-sp-2); }

  .splash-guidance {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    line-height: 1.6;
    color: var(--s-ink-2);
    margin: 0 0 var(--s-sp-2);
    max-width: 480px;
  }

  .splash-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-sp-3);
    margin-top: var(--s-sp-6);
  }

  .splash-remotes {
    list-style: none;
    margin: var(--s-sp-8) 0 0;
    padding: var(--s-sp-4) 0 0;
    border-top: var(--s-hair) solid var(--s-line);
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
  }
  .splash-remotes li {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok  { background: var(--s-moss); }
  .dot.bad { background: var(--s-seal); }
  .rname  { color: var(--s-ink); }
  .rstate { color: var(--s-ink-3); margin-left: auto; }

  @media (max-width: 480px) {
    .splash-stage { padding: var(--s-sp-6) var(--s-sp-4) var(--s-sp-8); }
    .wiz-topbar { padding-left: var(--s-sp-4); padding-right: var(--s-sp-4); }
    .btn { width: 100%; }
  }
</style>
