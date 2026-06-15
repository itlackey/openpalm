<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Severity = 'danger' | 'warning' | 'info' | 'success';

  // ── The single highest-priority attention state. Migration outranks stack
  //    state: an un-migrated/unreadable home must be resolved before anything else.
  const view = $derived.by(() => {
    const m = data.migration;
    if (m.status === 'error') return { kind: 'migration-error' as const };
    if (m.status === 'pending') return { kind: 'migration-pending' as const };
    return { kind: 'stack' as const, state: data.launchStatus.local.state };
  });

  // ── Migration flow client state ──────────────────────────────────────────────
  type Phase =
    | { name: 'idle' }
    | { name: 'applying' }
    | { name: 'lowspace'; message: string; estimatedBytes: number; freeBytes: number }
    | { name: 'done'; from: number; to: number; applied: string[]; releaseApplied: string[]; backupDir: string | null; notes: string[] }
    | { name: 'error'; message: string; guidance?: string };

  let phase = $state<Phase>({ name: 'idle' });

  async function applyMigration(confirmLowSpace = false) {
    phase = { name: 'applying' };
    try {
      const res = await fetch('/admin/migrate-apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmLowSpace }),
      });
      const body = await res.json();
      if (res.status === 409 && body?.error === 'low_space') {
        phase = { name: 'lowspace', message: body.message, estimatedBytes: body.estimatedBytes, freeBytes: body.freeBytes };
        return;
      }
      if (!res.ok || !body?.ok) {
        phase = { name: 'error', message: body?.message ?? `Update failed (HTTP ${res.status})`, guidance: body?.guidance };
        return;
      }
      phase = {
        name: 'done',
        from: body.from, to: body.to,
        applied: body.applied ?? [], releaseApplied: body.releaseApplied ?? [],
        backupDir: body.backupDir ?? null, notes: body.notes ?? [],
      };
    } catch (e) {
      phase = { name: 'error', message: e instanceof Error ? e.message : 'Network error while applying the update.' };
    }
  }

  // Continue: reload via the root so the launch-routing guard re-evaluates fresh
  // state and sends the user onward (chat when healthy, or the next attention state).
  function goContinue() {
    window.location.href = '/';
  }

  // Focus the post-action confirm button when the migration finishes — appropriate
  // (it follows a user action and the heading has already changed). We deliberately
  // do NOT auto-focus controls on initial page load, so a screen reader reads the
  // eyebrow/title/lede first.
  const focusOnMount = (node: HTMLElement) => { node.focus(); };

  function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

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

  // A persistent live region announces migration progress to screen-reader users
  // (DOM-swapping the visible content does not reliably announce on its own).
  const liveMsg = $derived.by(() => {
    if (view.kind !== 'migration-pending') return '';
    switch (phase.name) {
      case 'applying': return 'Updating your settings folder, please wait.';
      case 'done': return 'Update complete. You can continue.';
      case 'error': return 'The update did not complete.';
      case 'lowspace': return 'Low disk space detected. Confirm to proceed.';
      default: return '';
    }
  });
</script>

<svelte:head><title>OpenPalm</title></svelte:head>

<div class="setup-page">
  <header class="wiz-topbar">
    <div class="wiz-wordmark">
      <img src="/logo-128.png" alt="" />
      <b>OpenPalm</b>
    </div>
  </header>

  <main class="splash-stage">
    <p class="sr-only" role="status" aria-live="polite">{liveMsg}</p>

    <div class="splash-panel">

      {#if view.kind === 'migration-error'}
        <!-- Highest priority: the home can't be read / migration refused (fail-loud). -->
        <p class="wiz-eyebrow"><span class="sev-dot sev-danger" aria-hidden="true"></span>Can’t continue</p>
        <h1 class="wiz-title">We couldn’t read your <span class="accent">settings</span></h1>
        {#if data.migration.status === 'error'}
          <p class="wiz-lede">{data.migration.message}</p>
          <p class="splash-guidance">{data.migration.guidance || 'If this keeps happening, check the application logs or re-run setup.'}</p>
        {/if}

      {:else if view.kind === 'migration-pending'}
        {#if phase.name === 'done'}
          <p class="wiz-eyebrow"><span class="sev-dot sev-success" aria-hidden="true"></span>All done</p>
          <h1 class="wiz-title">Your data is <span class="accent">up to date</span></h1>
          <p class="wiz-lede">OpenPalm finished updating your settings. Everything was backed up first.</p>
          <ul class="splash-summary">
            {#if phase.backupDir}<li><span>Backed up to</span><code>{phase.backupDir}</code></li>{/if}
            <li><span>What changed</span><span>Settings layout v{phase.from} → v{phase.to}</span></li>
          </ul>
          {#if phase.notes.length}
            <ul class="splash-notes">{#each phase.notes as note}<li>{note}</li>{/each}</ul>
          {/if}
          <div class="splash-actions">
            <button class="btn btn-primary btn-lg" onclick={goContinue} {@attach focusOnMount}>Continue to OpenPalm</button>
          </div>
        {:else if phase.name === 'error'}
          <p class="wiz-eyebrow"><span class="sev-dot sev-danger" aria-hidden="true"></span>Didn’t finish</p>
          <h1 class="wiz-title">The update didn’t complete</h1>
          <p class="wiz-lede">{phase.message}</p>
          <p class="splash-guidance">{phase.guidance || 'Your files were not changed. Try again, or check the application logs if it keeps failing.'}</p>
          <div class="splash-actions">
            <button class="btn btn-primary btn-lg" onclick={() => applyMigration()}>Try again</button>
          </div>
        {:else if phase.name === 'lowspace'}
          <p class="wiz-eyebrow"><span class="sev-dot sev-warning" aria-hidden="true"></span>Low disk space</p>
          <h1 class="wiz-title">The safety backup may not fit</h1>
          <p class="wiz-lede">{phase.message}</p>
          <ul class="splash-summary">
            <li><span>Backup needs</span><span>{fmtBytes(phase.estimatedBytes)}</span></li>
            <li><span>Free space</span><span>{fmtBytes(phase.freeBytes)}</span></li>
          </ul>
          <p class="splash-guidance">Your home is always backed up before updating, and nothing has changed yet.</p>
          <div class="splash-actions">
            <button class="btn btn-danger btn-lg" onclick={() => applyMigration(true)}>Apply anyway</button>
            <button class="btn btn-ghost btn-lg" onclick={() => (phase = { name: 'idle' })}>Not now</button>
          </div>
        {:else}
          <p class="wiz-eyebrow"><span class="sev-dot sev-warning" aria-hidden="true"></span>One quick step</p>
          <h1 class="wiz-title">A small update to your <span class="accent">settings</span></h1>
          <p class="wiz-lede">
            Before you continue, OpenPalm needs to reorganize your settings folder to match this
            version. It’s safe — a full backup is taken first and your existing files are kept.
          </p>
          {#if data.migration.status === 'pending' && data.migration.notes.length}
            <ul class="splash-notes">{#each data.migration.notes as note}<li>{note}</li>{/each}</ul>
          {/if}
          <div class="splash-actions">
            <button class="btn btn-primary btn-lg" onclick={() => applyMigration()} disabled={phase.name === 'applying'}>
              {#if phase.name === 'applying'}<span class="spinner" aria-hidden="true"></span>Updating…{:else}Update now{/if}
            </button>
          </div>
          <p class="splash-reassure">
            This usually takes a few seconds. Your settings, secrets, and saved data are copied to a
            timestamped backup folder first, so you can always restore your previous state.
          </p>
        {/if}

      {:else}
        <!-- Stack-state guidance. -->
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
            <a class="btn btn-primary btn-lg" href="/setup">Run setup</a>
            {#if accessibleRemote}<a class="btn btn-outline btn-lg" href="/chat">Use {accessibleRemote.name}</a>
            {:else}<button class="btn btn-ghost btn-lg" onclick={() => window.location.reload()}>Reload</button>{/if}
          {:else if view.state === 'setup_incomplete'}
            <a class="btn btn-primary btn-lg" href="/setup">Resume setup</a>
          {:else if view.state === 'installed_offline'}
            <a class="btn btn-primary btn-lg" href="/admin">Open dashboard</a>
            <button class="btn btn-outline btn-lg" onclick={() => window.location.reload()}>Reload</button>
          {:else if view.state === 'installed_broken'}
            <a class="btn btn-primary btn-lg" href="/admin">Open diagnostics</a>
            <button class="btn btn-outline btn-lg" onclick={() => window.location.reload()}>Retry</button>
          {:else if view.state === 'running'}
            <a class="btn btn-primary btn-lg" href="/chat">Open chat</a>
            <a class="btn btn-ghost btn-lg" href="/admin">Admin</a>
          {/if}
        </div>

        {#if remotes.length}
          <ul class="splash-remotes" aria-label="Remote connections">
            {#each remotes as remote}
              <li>
                <span class="dot {remote.state === 'accessible' ? 'ok' : 'bad'}" aria-hidden="true"></span>
                <span class="rname">{remote.name}</span>
                <span class="rstate">{remoteLabel(remote.state)}</span>
              </li>
            {/each}
          </ul>
        {/if}
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
    padding: clamp(var(--space-8), 8vh, var(--space-12)) var(--space-6) var(--space-12);
  }
  .splash-panel {
    width: 100%;
    max-width: 32rem;
  }

  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0);
    white-space: nowrap; border: 0;
  }

  /* Calm, neutral eyebrow like the wizard's; severity reads from the wording + a
     small leading dot (12px AA-safe secondary text keeps it above the contrast +
     small-text thresholds, while the decorative dot restores the at-a-glance
     severity signal). */
  .splash-panel .wiz-eyebrow {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-tertiary);
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .sev-dot {
    width: 7px; height: 7px; border-radius: 50%; flex: none;
  }
  .sev-dot.sev-danger { background: var(--color-danger); }
  .sev-dot.sev-warning { background: var(--color-warning); }
  .sev-dot.sev-info { background: var(--color-primary); }
  .sev-dot.sev-success { background: var(--color-success); }

  /* Single, controlled gap before the actions (the wizard's .wiz-lede carries a
     32px bottom margin; don't stack another 32px on top of it). */
  .splash-panel :global(.wiz-lede) { margin-bottom: var(--space-2); }

  .splash-guidance {
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--color-text-secondary);
    margin: 0 0 var(--space-2);
    max-width: 480px;
  }

  .splash-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin-top: var(--space-6);
  }

  .spinner {
    width: 14px; height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    display: inline-block;
    animation: splash-spin 0.7s linear infinite;
  }
  @keyframes splash-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { display: none; } }

  /* Reassurance note below the migration CTA — adds calm context (and vertical
     weight) without competing with the primary action. */
  .splash-reassure {
    margin: var(--space-5) 0 0;
    max-width: 30rem;
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--color-text-tertiary);
  }

  .splash-summary {
    list-style: none;
    margin: var(--space-2) 0 var(--space-4);
    padding: var(--space-4) var(--space-5);
    background: var(--color-bg-secondary);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .splash-summary li {
    display: flex;
    gap: var(--space-4);
    align-items: baseline;
    font-size: var(--text-sm);
  }
  .splash-summary li > span:first-child { color: var(--color-text-secondary); min-width: 7rem; }
  .splash-summary code {
    font-size: 0.85em;
    color: var(--color-text);
    word-break: break-all;
  }

  .splash-notes {
    margin: 0 0 var(--space-4);
    padding-left: var(--space-5);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    line-height: 1.6;
  }
  .splash-notes li { margin-bottom: var(--space-1); }

  .splash-remotes {
    list-style: none;
    margin: var(--space-10) 0 0;
    padding: var(--space-4) 0 0;
    border-top: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .splash-remotes li { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok { background: var(--color-success); }
  .dot.bad { background: var(--color-danger); }
  .rname { color: var(--color-text); }
  .rstate { color: var(--color-text-secondary); margin-left: auto; }

  @media (max-width: 480px) {
    .splash-stage { padding: var(--space-6) var(--space-4) var(--space-8); }
    /* Align the topbar's horizontal inset with the content inset on mobile. */
    .wiz-topbar { padding-left: var(--space-4); padding-right: var(--space-4); }
    .splash-summary li { flex-direction: column; gap: var(--space-1); }
    .btn { width: 100%; }
  }
</style>
