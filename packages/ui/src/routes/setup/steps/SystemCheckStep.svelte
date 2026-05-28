<script lang="ts">
  import { onMount } from 'svelte';
  import FriendlyError from '$lib/components/FriendlyError.svelte';
  import { friendlyError, type FriendlyErrorView } from '$lib/wizard/error-messages.js';

  interface CheckResult {
    ok: boolean;
    version?: string;
    error?: string;
  }

  interface PortResult { port: number; available: boolean; blocking?: boolean; }

  interface SystemCheckResponse {
    ok: boolean;
    docker: CheckResult;
    compose: CheckResult;
    portCheckReliable: boolean;
    ports: PortResult[];
    platform: string;
    gpu?: string;
  }

  interface Props {
    onnext: () => void;
    onpass: () => void;
    ongpudetected?: (gpu: string) => void;
    /** True when re-running an existing install; suppresses misleading
     *  port-conflict warnings that just reflect the running stack itself. */
    isRerun?: boolean;
  }

  let { onnext, onpass, ongpudetected, isRerun = false }: Props = $props();

  let loading = $state(true);
  let result = $state<SystemCheckResponse | null>(null);
  let errorView = $state<FriendlyErrorView | null>(null);

  // Suppress port conflicts during a re-run — the ports are bound by the
  // running OpenPalm stack itself, which is expected.
  const portConflicts = $derived(
    isRerun ? [] : (result?.ports.filter((p) => !p.available) ?? []),
  );
  const blockingPortConflicts = $derived(portConflicts.filter((p) => p.blocking));
  const hasBlockingConflict = $derived(blockingPortConflicts.length > 0);
  const allRequiredPassed = $derived(
    !!result?.docker.ok && !!result?.compose.ok && !hasBlockingConflict,
  );

  function dockerInstallLink(platform: string | undefined): { label: string; href: string } {
    if (platform === 'darwin') return { label: 'Install Docker Desktop for Mac', href: 'https://www.docker.com/products/docker-desktop/' };
    if (platform === 'win32')  return { label: 'Install Docker Desktop for Windows', href: 'https://www.docker.com/products/docker-desktop/' };
    return { label: 'Install Docker Engine for Linux', href: 'https://docs.docker.com/engine/install/' };
  }

  function dockerStartHint(platform: string | undefined): string {
    if (platform === 'darwin' || platform === 'win32') return 'Open Docker Desktop and wait for it to finish starting, then click Retry.';
    return 'Run `sudo systemctl start docker` (or your distro\'s equivalent), then click Retry.';
  }

  async function runChecks(): Promise<void> {
    loading = true;
    errorView = null;
    try {
      const res = await fetch('/api/setup/system-check');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as SystemCheckResponse;
      result = data;
      if (data.docker.ok && data.compose.ok) onpass();
      if (data.gpu) ongpudetected?.(data.gpu);
    } catch (err) {
      errorView = friendlyError(err, 'system-check');
      result = null;
    } finally {
      loading = false;
    }
  }

  onMount(() => { void runChecks(); });
</script>

<h2>System Check</h2>
<p class="step-description">Let's make sure your machine has everything OpenPalm needs.</p>

{#if errorView}
  <FriendlyError error={errorView} />
{/if}

<div class="syscheck-list" aria-live="polite">
  <div class="syscheck-row" class:syscheck-row--ok={result?.docker.ok} class:syscheck-row--fail={result && !result.docker.ok}>
    <div class="syscheck-icon">
      {#if loading}
        <span class="spinner"></span>
      {:else if result?.docker.ok}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-success, #16a34a)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      {:else}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      {/if}
    </div>
    <div class="syscheck-body">
      <div class="syscheck-title">Docker is installed and running</div>
      {#if result?.docker.ok && result.docker.version}
        <div class="syscheck-meta">Docker server {result.docker.version}</div>
      {:else if result && !result.docker.ok}
        <div class="syscheck-hint">
          {result.docker.error?.includes('not found') || result.docker.error?.includes('ENOENT')
            ? 'Docker isn\'t installed yet.'
            : dockerStartHint(result.platform)}
        </div>
        <a class="syscheck-link" href={dockerInstallLink(result.platform).href} target="_blank" rel="noopener noreferrer">
          {dockerInstallLink(result.platform).label} →
        </a>
      {/if}
    </div>
  </div>

  <div class="syscheck-row" class:syscheck-row--ok={result?.compose.ok} class:syscheck-row--fail={result && !result.compose.ok}>
    <div class="syscheck-icon">
      {#if loading}
        <span class="spinner"></span>
      {:else if result?.compose.ok}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-success, #16a34a)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      {:else}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      {/if}
    </div>
    <div class="syscheck-body">
      <div class="syscheck-title">Docker can run multi-container apps</div>
      {#if result?.compose.ok && result.compose.version}
        <div class="syscheck-meta">{result.compose.version}</div>
      {:else if result && !result.compose.ok}
        <div class="syscheck-hint">
          Compose v2 ships with Docker Desktop. Linux users may need to install the `docker-compose-plugin` package.
        </div>
        <a class="syscheck-link" href="https://docs.docker.com/compose/install/" target="_blank" rel="noopener noreferrer">
          Compose installation guide →
        </a>
      {/if}
    </div>
  </div>

  {#if result?.gpu}
    <div class="syscheck-row syscheck-row--ok">
      <div class="syscheck-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-success, #16a34a)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div class="syscheck-body">
        <div class="syscheck-title">GPU detected</div>
        <div class="syscheck-meta">{result.gpu}</div>
      </div>
    </div>
  {/if}

  {#if result && portConflicts.length > 0}
    <div class="syscheck-row {hasBlockingConflict ? 'syscheck-row--fail' : 'syscheck-row--warn'}">
      <div class="syscheck-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={hasBlockingConflict ? '#dc2626' : '#d97706'} stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 9v4"/><path d="M12 17h.01"/>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        </svg>
      </div>
      <div class="syscheck-body">
        <div class="syscheck-title">Port conflict on {portConflicts.map((p) => p.port).join(', ')}</div>
        <div class="syscheck-hint">
          {#if !result.portCheckReliable}
            Docker is not running — start Docker and click Retry to confirm.
          {:else}
            Another program is using this port. Quit it and click Retry.
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<div class="step-actions">
  <button class="btn btn-secondary" id="btn-syscheck-retry" onclick={() => runChecks()} disabled={loading}>
    {loading ? 'Checking…' : 'Retry checks'}
  </button>
  <button class="btn btn-primary" id="btn-syscheck-next" onclick={onnext}
    disabled={loading || !allRequiredPassed}>
    Continue
  </button>
</div>

<style>
  .syscheck-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 16px 0;
  }
  .syscheck-row {
    display: flex;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 8px;
    background: var(--color-bg, #fff);
  }
  .syscheck-row--ok { background: #f0fdf4; border-color: #bbf7d0; }
  .syscheck-row--fail { background: #fef2f2; border-color: #fecaca; }
  .syscheck-row--warn { background: #fffbeb; border-color: #fde68a; }
  .syscheck-icon {
    flex: 0 0 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-top: 2px;
  }
  .syscheck-body { flex: 1; min-width: 0; }
  .syscheck-title { font-weight: 600; font-size: var(--text-sm, 0.875rem); }
  .syscheck-meta {
    margin-top: 2px;
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-secondary, #6b7280);
  }
  .syscheck-hint {
    margin-top: 4px;
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-secondary, #525252);
  }
  .syscheck-link {
    display: inline-block;
    margin-top: 6px;
    color: var(--color-primary, #4f6ef7);
    font-size: var(--text-xs, 0.75rem);
    text-decoration: none;
    font-weight: 500;
  }
  .syscheck-link:hover { text-decoration: underline; }
  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid #e5e7eb;
    border-top-color: var(--color-primary, #4f6ef7);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
