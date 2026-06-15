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
        phase = { name: 'error', message: body?.message ?? `Migration failed (HTTP ${res.status})`, guidance: body?.guidance };
        return;
      }
      phase = {
        name: 'done',
        from: body.from, to: body.to,
        applied: body.applied ?? [], releaseApplied: body.releaseApplied ?? [],
        backupDir: body.backupDir ?? null, notes: body.notes ?? [],
      };
    } catch (e) {
      phase = { name: 'error', message: e instanceof Error ? e.message : 'Network error while applying the migration.' };
    }
  }

  // Continue: reload via the root so the launch-routing guard re-evaluates fresh
  // state and sends the user onward (chat when healthy, or the next attention state).
  function goContinue() {
    window.location.href = '/';
  }

  const focusOnMount = (node: HTMLElement) => { node.focus(); };

  function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
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
          body: 'OpenPalm is installed but nothing is running right now. Start the stack, then reload to continue.' };
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

<main class="setup-page">
  <header class="wiz-topbar">
    <div class="wiz-wordmark">
      <img src="/logo-128.png" alt="" />
      <b>OpenPalm</b>
    </div>
  </header>

  <div class="splash-stage">
    <div class="splash-panel">

      {#if view.kind === 'migration-error'}
        <!-- Highest priority: the home can't be read / migration refused (fail-loud). -->
        <p class="wiz-eyebrow sev-danger">Can’t continue</p>
        <h1 class="wiz-title">We couldn’t read your <span class="accent">home directory</span></h1>
        {#if data.migration.status === 'error'}
          <p class="wiz-lede">{data.migration.message}</p>
          <p class="splash-guidance">{data.migration.guidance}</p>
        {/if}

      {:else if view.kind === 'migration-pending'}
        {#if phase.name === 'done'}
          <p class="wiz-eyebrow sev-success">All done</p>
          <h1 class="wiz-title">Your data is <span class="accent">up to date</span></h1>
          <p class="wiz-lede">OpenPalm updated your home directory to the current layout. Everything was backed up first.</p>
          <ul class="splash-summary">
            <li><span>Layout</span><span>v{phase.from} → v{phase.to}</span></li>
            {#if phase.backupDir}<li><span>Backup saved</span><code>{phase.backupDir}</code></li>{/if}
          </ul>
          {#if phase.notes.length}
            <ul class="splash-notes">{#each phase.notes as note}<li>{note}</li>{/each}</ul>
          {/if}
          <div class="splash-actions">
            <button class="btn btn-primary btn-lg" onclick={goContinue} {@attach focusOnMount}>Continue</button>
          </div>
        {:else if phase.name === 'error'}
          <p class="wiz-eyebrow sev-danger">Didn’t finish</p>
          <h1 class="wiz-title">The update didn’t complete</h1>
          <p class="wiz-lede">{phase.message}</p>
          {#if phase.guidance}<p class="splash-guidance">{phase.guidance}</p>{/if}
          <div class="splash-actions">
            <button class="btn btn-primary btn-lg" onclick={() => applyMigration()}>Try again</button>
          </div>
        {:else if phase.name === 'lowspace'}
          <p class="wiz-eyebrow sev-warning">Low disk space</p>
          <h1 class="wiz-title">The safety backup may not fit</h1>
          <p class="wiz-lede">{phase.message}</p>
          <p class="splash-guidance">Estimated backup: {fmtBytes(phase.estimatedBytes)} · Free space: {fmtBytes(phase.freeBytes)}. Your home is always backed up before migrating, and nothing has changed yet.</p>
          <div class="splash-actions">
            <button class="btn btn-danger btn-lg" onclick={() => applyMigration(true)}>Apply anyway</button>
          </div>
        {:else}
          <p class="wiz-eyebrow sev-warning">One quick step</p>
          <h1 class="wiz-title">A small update to your <span class="accent">data</span></h1>
          <p class="wiz-lede">
            Before you continue, OpenPalm needs to update your home directory to the current
            layout{#if data.migration.status === 'pending'} (v{data.migration.from} → v{data.migration.to}){/if}.
            It’s safe — a full backup is taken first and your existing files are kept.
          </p>
          {#if data.migration.status === 'pending' && data.migration.notes.length}
            <ul class="splash-notes">{#each data.migration.notes as note}<li>{note}</li>{/each}</ul>
          {/if}
          <div class="splash-actions">
            <button class="btn btn-primary btn-lg" onclick={() => applyMigration()} disabled={phase.name === 'applying'} {@attach focusOnMount}>
              {phase.name === 'applying' ? 'Updating…' : 'Update now'}
            </button>
          </div>
          {#if phase.name === 'applying'}
            <p class="splash-progress" role="status" aria-live="polite">Updating your home directory…</p>
          {/if}
        {/if}

      {:else}
        <!-- Stack-state guidance. -->
        <p class="wiz-eyebrow sev-{stackCard.severity}">{stackCard.eyebrow}</p>
        <h1 class="wiz-title">{stackCard.title}</h1>
        <p class="wiz-lede">{stackCard.body}</p>

        {#if view.state === 'not_installed' && runtime && !runtime.dockerPresent}
          <p class="splash-guidance">No container runtime detected. Install Docker (or OrbStack / Podman), start it, then reload this page.</p>
        {/if}
        {#if view.state === 'installed_broken'}
          <p class="splash-guidance">Unhealthy services are listed in Diagnostics; container logs show the underlying error.</p>
        {/if}

        <div class="splash-actions">
          {#if view.state === 'not_installed'}
            <a class="btn btn-primary btn-lg" href="/setup" {@attach focusOnMount}>Run setup</a>
            {#if accessibleRemote}<a class="btn btn-outline btn-lg" href="/chat">Use {accessibleRemote.name}</a>{/if}
          {:else if view.state === 'setup_incomplete'}
            <a class="btn btn-primary btn-lg" href="/setup" {@attach focusOnMount}>Resume setup</a>
          {:else if view.state === 'installed_offline'}
            <button class="btn btn-primary btn-lg" onclick={() => window.location.reload()} {@attach focusOnMount}>Reload status</button>
          {:else if view.state === 'installed_broken'}
            <a class="btn btn-primary btn-lg" href="/admin" {@attach focusOnMount}>Open diagnostics</a>
            <button class="btn btn-outline btn-lg" onclick={() => window.location.reload()}>Retry</button>
          {:else if view.state === 'running'}
            <a class="btn btn-primary btn-lg" href="/chat" {@attach focusOnMount}>Open chat</a>
            <a class="btn btn-ghost btn-lg" href="/admin">Admin</a>
          {/if}
        </div>

        {#if remotes.length}
          <ul class="splash-remotes" aria-label="Remote connections">
            {#each remotes as remote}
              <li>
                <span class="dot {remote.state === 'accessible' ? 'ok' : 'bad'}" aria-hidden="true"></span>
                <span class="rname">{remote.name}</span>
                <span class="rstate">{remote.state}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}

    </div>
  </div>
</main>

<style>
  /* Calm, centered single-column stage — mirrors the setup wizard's friendly,
     low-density feel (full-height page, wordmark topbar, big title + lede). */
  .splash-stage {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-8) var(--space-6) var(--space-12);
    overflow-y: auto;
  }
  .splash-panel {
    width: 100%;
    max-width: 32rem;
  }

  /* Severity tint on the eyebrow (the wizard keeps eyebrows tertiary; we colour
     them so the attention level reads at a glance without a heavy card). */
  .wiz-eyebrow.sev-danger { color: var(--color-danger); }
  .wiz-eyebrow.sev-warning { color: var(--color-warning); }
  .wiz-eyebrow.sev-info { color: var(--color-accent-text, var(--color-primary)); }
  .wiz-eyebrow.sev-success { color: var(--color-success-text, var(--color-success)); }

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
    margin-top: var(--space-8);
  }

  .splash-summary {
    list-style: none;
    margin: 0 0 var(--space-4);
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

  .splash-progress {
    margin: var(--space-4) 0 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

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
    .splash-stage { padding: var(--space-6) var(--space-4) var(--space-8); align-items: flex-start; }
    .splash-summary li { flex-direction: column; gap: var(--space-1); }
    .btn { width: 100%; }
  }
</style>
