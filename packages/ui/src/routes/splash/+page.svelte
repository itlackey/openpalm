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
  type Card = { severity: Severity; badge: string; title: string; body: string };
  const stackCard = $derived.by<Card>(() => {
    switch (data.launchStatus.local.state) {
      case 'not_installed':
        return { severity: 'info', badge: 'Welcome', title: 'OpenPalm isn’t installed yet',
          body: 'Run the setup wizard to install the stack, or connect to an assistant running somewhere else.' };
      case 'setup_incomplete':
        return { severity: 'warning', badge: 'Action needed', title: 'Setup isn’t finished',
          body: 'Installation was started but never completed. Resume the setup wizard to finish configuring your stack.' };
      case 'installed_offline':
        return { severity: 'warning', badge: 'Stopped', title: 'Your stack isn’t running',
          body: 'OpenPalm is installed but no containers are up. Start the stack to continue, then reload this page.' };
      case 'installed_broken':
        return { severity: 'danger', badge: 'Needs attention', title: 'Your stack has a problem',
          body: 'OpenPalm is running but one or more services are unhealthy. Check the diagnostics and container logs to see what failed.' };
      case 'running':
        return { severity: 'success', badge: 'Ready', title: 'Everything’s running',
          body: 'Your stack is healthy. Open the chat to start talking to your assistant.' };
      default:
        return { severity: 'info', badge: 'Status', title: 'OpenPalm', body: '' };
    }
  });

  const runtime = $derived(data.launchStatus.local.runtime);
  const remotes = $derived(data.launchStatus.remotes);
  const accessibleRemote = $derived(remotes.find((r) => r.state === 'accessible'));
</script>

<svelte:head><title>OpenPalm</title></svelte:head>

<main class="splash">
  <header class="brand">
    <h1>OpenPalm</h1>
    <p class="tagline">Self-hosted AI assistant</p>
  </header>

  {#if view.kind === 'migration-error'}
    <!-- Highest priority: the home can't be read / migration refused (fail-loud). -->
    <section class="card danger" aria-labelledby="att-title">
      <span class="badge danger">Can’t continue</span>
      <h2 id="att-title">OpenPalm couldn’t read your home directory</h2>
      <p>{data.migration.status === 'error' ? data.migration.message : ''}</p>
      {#if data.migration.status === 'error'}
        <p class="guidance">{data.migration.guidance}</p>
      {/if}
    </section>

  {:else if view.kind === 'migration-pending'}
    <!-- Migration required before continuing. -->
    <section class="card warning" aria-labelledby="att-title">
      {#if phase.name === 'done'}
        <span class="badge success">Done</span>
        <h2 id="att-title">Migration complete</h2>
        <p>Your OpenPalm home was updated to the current layout. You can continue.</p>
        <dl class="report">
          <div><dt>Layout</dt><dd>v{phase.from} → v{phase.to}</dd></div>
          {#if phase.applied.length}<div><dt>Applied</dt><dd>{phase.applied.join(', ')}</dd></div>{/if}
          {#if phase.releaseApplied.length}<div><dt>Release steps</dt><dd>{phase.releaseApplied.join(', ')}</dd></div>{/if}
          {#if phase.backupDir}<div><dt>Backup</dt><dd><code>{phase.backupDir}</code></dd></div>{/if}
        </dl>
        {#if phase.notes.length}
          <ul class="notes">{#each phase.notes as note}<li>{note}</li>{/each}</ul>
        {/if}
        <div class="actions">
          <button class="btn btn-primary" onclick={goContinue} {@attach focusOnMount}>Continue</button>
        </div>
      {:else if phase.name === 'error'}
        <span class="badge danger">Failed</span>
        <h2 id="att-title">Migration didn’t complete</h2>
        <p>{phase.message}</p>
        {#if phase.guidance}<p class="guidance">{phase.guidance}</p>{/if}
        <div class="actions">
          <button class="btn btn-outline" onclick={() => applyMigration()}>Try again</button>
        </div>
      {:else if phase.name === 'lowspace'}
        <span class="badge warning">Low disk space</span>
        <h2 id="att-title">The safety backup may not fit</h2>
        <p>{phase.message}</p>
        <p class="guidance">Estimated backup size: {fmtBytes(phase.estimatedBytes)} · Free space: {fmtBytes(phase.freeBytes)}. The migration always backs up your home first; nothing has been changed.</p>
        <div class="actions">
          <button class="btn btn-danger" onclick={() => applyMigration(true)}>Apply anyway</button>
        </div>
      {:else}
        <span class="badge warning">Action needed</span>
        <h2 id="att-title">A quick update to your data is required</h2>
        <p>Before you continue, OpenPalm needs to migrate your home directory to the current layout (v{data.migration.status === 'pending' ? data.migration.from : ''} → v{data.migration.status === 'pending' ? data.migration.to : ''}). This is safe — a full backup is taken first and your existing files are preserved.</p>
        {#if data.migration.status === 'pending' && data.migration.notes.length}
          <ul class="notes">{#each data.migration.notes as note}<li>{note}</li>{/each}</ul>
        {/if}
        <div class="actions">
          <button class="btn btn-primary" onclick={() => applyMigration()} disabled={phase.name === 'applying'}>
            {phase.name === 'applying' ? 'Applying…' : 'Apply migration'}
          </button>
        </div>
        {#if phase.name === 'applying'}
          <p class="progress" role="status" aria-live="polite">Migrating your home directory…</p>
        {/if}
      {/if}
    </section>

  {:else}
    <!-- Stack-state guidance. -->
    <section class="card {stackCard.severity}" aria-labelledby="att-title">
      <span class="badge {stackCard.severity}">{stackCard.badge}</span>
      <h2 id="att-title">{stackCard.title}</h2>
      <p>{stackCard.body}</p>

      {#if view.state === 'not_installed' && runtime && !runtime.dockerPresent}
        <p class="guidance">No container runtime detected. Install Docker (or OrbStack / Podman) and start it, then reload this page.</p>
      {/if}

      {#if view.state === 'installed_broken'}
        <p class="guidance">Unhealthy services appear in the Diagnostics tab; container logs (<code>docker compose logs</code>) show the underlying error.</p>
      {/if}

      <div class="actions">
        {#if view.state === 'not_installed'}
          <a class="btn btn-primary" href="/setup" {@attach focusOnMount}>Run setup</a>
          {#if accessibleRemote}<a class="btn btn-outline" href="/chat">Use {accessibleRemote.name}</a>{/if}
        {:else if view.state === 'setup_incomplete'}
          <a class="btn btn-primary" href="/setup" {@attach focusOnMount}>Resume setup</a>
        {:else if view.state === 'installed_offline'}
          <button class="btn btn-primary" onclick={() => window.location.reload()} {@attach focusOnMount}>Reload status</button>
        {:else if view.state === 'installed_broken'}
          <a class="btn btn-primary" href="/admin" {@attach focusOnMount}>Open diagnostics</a>
          <button class="btn btn-outline" onclick={() => window.location.reload()}>Retry</button>
        {:else if view.state === 'running'}
          <a class="btn btn-primary" href="/chat" {@attach focusOnMount}>Open chat</a>
          <a class="btn btn-ghost" href="/admin">Admin</a>
        {/if}
      </div>
    </section>

    {#if remotes.length}
      <section class="aside" aria-label="Remote connections">
        <h3>Remote connections</h3>
        <ul class="remotes">
          {#each remotes as remote}
            <li>
              <span class="dot {remote.state === 'accessible' ? 'ok' : 'bad'}" aria-hidden="true"></span>
              <span class="rname">{remote.name}</span>
              <span class="rstate">{remote.state}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if runtime && view.state === 'not_installed'}
      <p class="runtime-note">Runtime: {runtime.runtimeName ?? 'Docker'} — {runtime.dockerPresent ? 'detected' : 'not found'}</p>
    {/if}
  {/if}
</main>

<style>
  .splash {
    max-width: 40rem;
    margin: 0 auto;
    padding: var(--space-12) var(--space-4) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  .brand { text-align: center; }
  .brand h1 { font-size: 2rem; margin: 0; color: var(--color-text); }
  .tagline { margin: var(--space-1) 0 0; color: var(--color-text-secondary); }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-left: 4px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    padding: var(--space-6);
  }
  .card.danger { border-left-color: var(--color-danger); }
  .card.warning { border-left-color: var(--color-warning); }
  .card.info { border-left-color: var(--color-primary); }
  .card.success { border-left-color: var(--color-success); }

  .card h2 { margin: var(--space-2) 0 var(--space-3); font-size: 1.25rem; color: var(--color-text); }
  .card p { margin: 0 0 var(--space-3); color: var(--color-text-secondary); line-height: 1.55; }
  .card p:last-of-type { margin-bottom: 0; }
  .guidance { font-size: var(--text-sm); }

  .badge {
    display: inline-block;
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .badge.danger { background: var(--color-danger-bg); color: var(--color-danger-fg, var(--color-danger)); }
  .badge.warning { background: var(--color-warning-bg); color: var(--color-warning); }
  .badge.info { background: var(--color-primary-subtle); color: var(--color-accent-text, var(--color-primary)); }
  .badge.success { background: var(--color-success-bg); color: var(--color-success-text, var(--color-success)); }

  .actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-5); }

  .report { margin: var(--space-4) 0 0; display: grid; gap: var(--space-2); }
  .report div { display: grid; grid-template-columns: 7rem 1fr; gap: var(--space-3); }
  .report dt { color: var(--color-text-secondary); font-size: var(--text-sm); }
  .report dd { margin: 0; color: var(--color-text); font-size: var(--text-sm); word-break: break-word; }
  .report code, .guidance code { font-size: 0.85em; background: var(--color-bg-secondary); padding: 1px 4px; border-radius: var(--radius-sm); }

  .notes { margin: var(--space-3) 0 0; padding-left: var(--space-5); color: var(--color-text-secondary); font-size: var(--text-sm); }
  .notes li { margin-bottom: var(--space-1); }
  .progress { margin-top: var(--space-3) !important; color: var(--color-text-secondary); font-size: var(--text-sm); }

  .aside { padding: 0 var(--space-2); }
  .aside h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-secondary); margin: 0 0 var(--space-3); }
  .remotes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .remotes li { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok { background: var(--color-success); }
  .dot.bad { background: var(--color-danger); }
  .rname { color: var(--color-text); }
  .rstate { color: var(--color-text-secondary); margin-left: auto; }

  .runtime-note { text-align: center; color: var(--color-text-secondary); font-size: var(--text-sm); margin: 0; }

  @media (max-width: 480px) {
    .splash { padding-top: var(--space-8); }
    .report div { grid-template-columns: 1fr; gap: var(--space-1); }
    .btn { width: 100%; }
  }
</style>
