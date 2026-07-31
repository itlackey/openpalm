<script lang="ts">
  import { onMount } from 'svelte';
  import FriendlyError from '$lib/components/common/FriendlyError.svelte';
  import IconServer from '$lib/components/icons/IconServer.svelte';
  import IconConnect from '$lib/components/icons/IconConnect.svelte';
  import { friendlyError, type FriendlyErrorView } from '$lib/client/error-messages.js';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { setupState } from '$lib/setup/setup-state.svelte.js';

  interface CheckResult {
    ok: boolean;
    version?: string;
    error?: string;
  }

  interface PortResult { port: number; available: boolean; blocking?: boolean; }

  interface HostProvider { provider: string; url: string; }

  interface RuntimeInfo {
    dockerPresent: boolean;
    dockerVersion?: string;
    composeAvailable: boolean;
    runtimeName?: 'Docker' | 'OrbStack' | 'Podman';
  }

  interface DiskResult {
    status: 'ok' | 'low' | 'critical';
    message: string | null;
    blocking: boolean;
  }

  interface SystemCheckResponse {
    ok: boolean;
    docker: CheckResult;
    compose: CheckResult;
    portCheckReliable: boolean;
    ports: PortResult[];
    platform: string;
    runtime?: RuntimeInfo;
    gpu?: string;
    hostProviders?: HostProvider[];
    disk?: DiskResult;
  }

  const PROVIDER_LABELS: Record<string, string> = {
    ollama: 'Ollama',
    lmstudio: 'LM Studio',
    'model-runner': 'Docker Model Runner',
  };

  const KNOWN_PROVIDERS = new Set(['ollama', 'lmstudio', 'model-runner']);

  // Takes NO props: reads the setup-state store directly (isRerun) and calls its
  // navigation / GPU-detection methods, mirroring Screen1ModelsStep / ReviewStep.
  // `onnext` and `onpass` both mapped to handleSystemCheckPass at the call site;
  // `ongpudetected` ignored its gpu argument (the store re-derives it).
  const s = setupState;

  const onnext = (): void => s.handleSystemCheckPass();
  const onpass = (): void => s.handleSystemCheckPass();
  const ongpudetected = (): void => s.handleGpuDetected();
  /** True when re-running an existing install; suppresses misleading
   *  port-conflict warnings that just reflect the running stack itself. */
  const isRerun = $derived(s.isRerun);

  let loading = $state(true);
  let result = $state<SystemCheckResponse | null>(null);
  let errorView = $state<FriendlyErrorView | null>(null);

  // Suppress port conflicts during a re-run — the ports are bound by the
  // running OpenPalm stack itself, which is expected.
  const portConflicts = $derived(
    isRerun ? [] : (result?.ports.filter((p) => !p.available) ?? []),
  );
  const blockingPortConflicts = $derived(portConflicts.filter((p) => p.blocking));
  // W11: `disk.blocking` only comes back true when the lib's own thresholds
  // intend a hard stop (critical reading AND the operator opted into
  // OP_DISK_HARD_BLOCK=1) — anything else is a warning row only, never gates.
  const diskBlocking = $derived(!!result?.disk?.blocking);
  const hasBlockingConflict = $derived(blockingPortConflicts.length > 0 || diskBlocking);
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
      // W3: auto-advance used to ignore hasBlockingConflict entirely — a user
      // with another app parked on 3800/3810/3880 (or, now, a hard disk-space
      // block) sailed straight through this screen and only hit an opaque
      // compose error at deploy time. `hasBlockingConflict` is derived from
      // the `result` just assigned above, so it already reflects this response.
      if (data.docker.ok && data.compose.ok && !hasBlockingConflict) onpass();
      if (data.gpu) ongpudetected();
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
        <Spinner size={16} />
      {:else if result?.docker.ok}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--s-moss)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      {:else}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--s-seal)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      {/if}
    </div>
      <div class="syscheck-body">
        <div class="syscheck-title">Docker is installed and running</div>
        {#if result?.docker.ok && result.docker.version}
          <div class="syscheck-meta">{result.runtime?.runtimeName ?? 'Docker'} server {result.docker.version}</div>
        {:else if result && !result.docker.ok}
        <div class="syscheck-hint">
          {result.docker.error?.includes('not found') || result.docker.error?.includes('ENOENT')
            ? 'Docker isn\'t installed yet.'
            : dockerStartHint(result.platform)}
        </div>
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external docs URL (docker.com), not an internal route -->
        <a class="syscheck-link" href={dockerInstallLink(result.platform).href} target="_blank" rel="noopener noreferrer">
          {dockerInstallLink(result.platform).label} →
        </a>
      {/if}
    </div>
  </div>

  <div class="syscheck-row" class:syscheck-row--ok={result?.compose.ok} class:syscheck-row--fail={result && !result.compose.ok}>
    <div class="syscheck-icon">
      {#if loading}
        <Spinner size={16} />
      {:else if result?.compose.ok}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--s-moss)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      {:else}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--s-seal)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
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
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--s-moss)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div class="syscheck-body">
        <div class="syscheck-title">GPU detected</div>
        <div class="syscheck-meta">{result.gpu}</div>
      </div>
    </div>
  {/if}

  {#if result?.hostProviders && result.hostProviders.length > 0}
    {#each result.hostProviders as hp (hp.provider)}
      <div class="syscheck-row syscheck-row--info">
        <div class="syscheck-icon" aria-hidden="true">
          {#if KNOWN_PROVIDERS.has(hp.provider)}<IconServer size={18} />{:else}<IconConnect size={18} />{/if}
        </div>
        <div class="syscheck-body">
          <div class="syscheck-title">{PROVIDER_LABELS[hp.provider] ?? hp.provider} is running</div>
          <div class="syscheck-meta">{hp.url}</div>
          <div class="syscheck-hint">We can use this automatically — pick your model on the Models step.</div>
        </div>
      </div>
    {/each}
  {/if}

  {#if result && portConflicts.length > 0}
    <div class="syscheck-row {hasBlockingConflict ? 'syscheck-row--fail' : 'syscheck-row--warn'}">
      <div class="syscheck-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={hasBlockingConflict ? 'var(--s-seal)' : 'var(--s-ink-2)'} stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
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

  {#if result?.disk && result.disk.status !== 'ok'}
    <div class="syscheck-row {diskBlocking ? 'syscheck-row--fail' : 'syscheck-row--warn'}">
      <div class="syscheck-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={diskBlocking ? 'var(--s-seal)' : 'var(--s-ink-2)'} stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 9v4"/><path d="M12 17h.01"/>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        </svg>
      </div>
      <div class="syscheck-body">
        <div class="syscheck-title">
          {result.disk.status === 'critical' ? 'Critically low disk space' : 'Low disk space'}
        </div>
        <div class="syscheck-hint">{result.disk.message}</div>
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
    border: var(--s-hair) solid var(--s-line);
    border-radius: 8px;
    background: var(--s-paper);
  }
  .syscheck-row--ok { background: color-mix(in srgb, var(--s-moss) 12%, transparent); border-color: color-mix(in srgb, var(--s-moss) 25%, transparent); }
  .syscheck-row--fail { background: color-mix(in srgb, var(--s-seal) 8%, transparent); border-color: color-mix(in srgb, var(--s-seal) 25%, transparent); }
  .syscheck-row--warn { background: color-mix(in srgb, var(--s-ink) 4%, var(--s-paper)); border-color: var(--s-line); }
  /* Info rows: neutral blue tint — informational only, no pass/fail signal.
     Uses --color-info-bg/border tokens if present; falls back to a blue-50/blue-200
     pair that clears 4.5:1 AA contrast for --color-text on both light and dark themes. */
  .syscheck-row--info {
    background: color-mix(in srgb, var(--s-moss) 8%, var(--s-paper));
    border-color: color-mix(in srgb, var(--s-moss) 25%, transparent);
  }
  .syscheck-icon {
    flex: 0 0 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-top: 2px;
  }
  .syscheck-body { flex: 1; min-width: 0; }
  .syscheck-title { font-weight: 600; font-size: var(--s-type-deed); }
  /* meta + hint sit inside the tinted status rows (success/danger/warning bg);
     --color-text-secondary falls just under AA (4.5:1) on those light tints, so
     use the primary text token — AA on every tint in both themes. Hierarchy is
     held by the 600-weight, larger .syscheck-title above. */
  .syscheck-meta {
    margin-top: 2px;
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }
  .syscheck-hint {
    margin-top: 4px;
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }
  .syscheck-link {
    display: inline-block;
    margin-top: 6px;
    color: var(--s-seal);
    font-size: var(--s-type-deed);
    text-decoration: none;
    font-weight: 500;
  }
  .syscheck-link:hover { text-decoration: underline; }
</style>
