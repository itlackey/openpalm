<script lang="ts">
  import FriendlyError from '$lib/components/common/FriendlyError.svelte';
  import { friendlyError } from '$lib/client/error-messages.js';
  import Spinner from '$lib/components/common/Spinner.svelte';

  interface ServiceStatus {
    service: string;
    status: string;
    label?: string;
  }

  type DeployPhase =
    | 'writing-config'
    | 'pulling-images'
    | 'starting'
    | 'starting-voice'
    | 'ready';

  interface DeployData {
    deploying?: boolean;
    setupComplete?: boolean;
    deployStatus?: ServiceStatus[];
    deployError?: string | null;
    /** Non-fatal: install used cached images because the registry pull failed. */
    imageWarning?: string | null;
    phase?: DeployPhase;
    ports?: { admin?: number; assistant?: number };
  }

  interface Props {
    deployData: DeployData;
    deployDone: boolean;
    /** Terminal state reached with non-running rows that are all warnings. */
    deployHasWarnings?: boolean;
    deployError: string | null;
    onback: () => void;
    onretry: () => void;
  }

  let { deployData, deployDone, deployHasWarnings = false, deployError, onback, onretry }: Props = $props();

  const warningRows = $derived(
    (deployData.deployStatus ?? []).filter((s) => s.status === 'warning'),
  );

  const isElectron = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).openpalm;

  // Fall back to the current window port (admin UI serves the wizard).
  const windowPort = typeof window !== 'undefined' ? Number(window.location.port) || 3880 : 3880;

  const adminPort = $derived(deployData.ports?.admin ?? windowPort);
  const assistantPort = $derived(deployData.ports?.assistant ?? 3800);

  const serviceLinks = $derived<Record<string, { port: number; label: string; path: string }>>({
    assistant: { port: assistantPort, label: 'Assistant (OpenCode)', path: '' },
    admin: { port: adminPort, label: 'Admin Dashboard', path: '' },
  });

  const services = $derived(deployData.deployStatus ?? []);
  const total = $derived(services.length);
  const running = $derived(services.filter((s) => s.status === 'running').length);
  const pct = $derived(total > 0 ? Math.round((running / total) * 100) : 0);

  const phase = $derived(deployData.phase ?? 'writing-config');

  // The voice addon ships a 2.4 GB image (CPU build) — much larger
  // than the other ~150-300 MB stack containers — so pulling it for
  // the first time on a typical home connection is the dominant
  // wait. Extend the messaging when the operator enabled it so they
  // don't think the install is stuck.
  const voiceEnabled = $derived(
    services.some((s) => /^voice(-cuda|-rocm)?$/.test(s.service ?? '')),
  );

  const deployTitle = $derived.by(() => {
    if (deployDone) return deployHasWarnings ? 'Setup Complete (with warnings)' : 'Setup Complete';
    if (deployError) return 'Deployment Issue';
    switch (phase) {
      case 'writing-config': return 'Preparing Configuration…';
      case 'pulling-images':
        return voiceEnabled
          ? 'Downloading Images (incl. Voice ~2.4 GB)…'
          : 'Downloading Images…';
      case 'starting': return 'Starting Services…';
      case 'starting-voice': return 'Starting Voice Addon…';
      case 'ready': return 'Setup Complete';
    }
    return 'Deploying…';
  });

  const deploySubtitle = $derived.by(() => {
    if (deployDone) {
      return deployHasWarnings
        ? 'Setup is complete. Some services are still warming up in the background — they will be ready shortly.'
        : 'Your OpenPalm stack is up and running.';
    }
    if (deployError) return 'Setup could not finish starting the stack.';
    switch (phase) {
      case 'writing-config': return 'Writing config files and validating settings.';
      case 'pulling-images':
        return voiceEnabled
          ? 'Downloading container images. The voice model (~2.4 GB) is the largest — on a typical home connection this step can take 10–30 minutes. The wizard will wait — keep this tab open.'
          : 'Downloading container images — first install can take 3–8 minutes depending on connection.';
      case 'starting': return `${running} of ${total} services running.`;
      case 'starting-voice':
        return 'Pulling the voice image (~2.4 GB) and warming up Kokoro + Whisper models. First launch can take 5–30 minutes on slow connections — the wizard will wait.';
      case 'ready': return 'All services are up.';
    }
    return 'Writing configuration and starting services.';
  });

  const noStartMode = $derived(deployDone && services.length === 0);
</script>

<div class="deploy-header">
  <h2 id="deploy-title">{deployTitle}</h2>
  <p class="step-description" id="deploy-subtitle">{deploySubtitle}</p>
</div>

<div class="deploy-progress-summary">
  <div class="deploy-progress-meta">
    <span class="deploy-progress-label">Progress</span>
    <span class="deploy-progress-value {deployError ? 'deploy-progress-value--error' : ''}" id="deploy-progress-value">
      {#if deployError}Error{:else if deployDone}{services.length > 0 ? '100%' : ''}{:else}{pct}%{/if}
    </span>
  </div>
  <div class="deploy-progress-bar">
    <div class="deploy-progress-fill" id="deploy-progress-fill"
      style="width:{deployDone && services.length > 0 ? 100 : (deployDone ? 0 : pct)}%">
    </div>
  </div>
</div>

<div class="deploy-services" id="deploy-services">
  {#each services as svc}
    <div class="deploy-service-row">
      <div class="deploy-service-indicator">
        {#if svc.status === 'running'}
          <span class="deploy-check">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--s-moss)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </span>
        {:else if svc.status === 'error' || svc.status === 'warning'}
          <span class="deploy-warning">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--s-ink-2)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v4"/><path d="M12 17h.01"/>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            </svg>
          </span>
        {:else}
          <span class="deploy-spinner"><Spinner /></span>
        {/if}
      </div>
      <div class="deploy-service-info">
        <span class="deploy-service-name">{svc.service || svc.label || ''}</span>
        <span class="deploy-service-status">{svc.label || svc.status}</span>
      </div>
      <div class="deploy-service-bar">
        <div class="deploy-bar-fill {svc.status === 'running' ? 'complete' : svc.status === 'ready' ? 'ready' : svc.status === 'warning' ? 'warning' : svc.status === 'error' ? 'stopped' : 'indeterminate'}">
        </div>
      </div>
    </div>
  {/each}
</div>

{#if deployError}
  <div id="deploy-failure">
    <FriendlyError error={friendlyError(deployError, 'deploy')} />
  </div>
{/if}

{#if !deployDone && !deployError}
  <aside class="deploy-tips" id="deploy-tips">
    <div class="deploy-tips-header">
      <span class="deploy-tips-kicker">Tips</span>
      <h3>{voiceEnabled ? 'First install may take 10–30 minutes' : 'First startup takes a few minutes'}</h3>
    </div>
    <ul>
      {#if voiceEnabled}
        <li>The OpenPalm Voice image is ~2.4 GB — the largest piece by far. Download speed depends on your internet connection.</li>
        <li>The wizard waits as long as the download takes. Progress bars below show each service's state.</li>
      {:else}
        <li>Container images are being downloaded for the first time.</li>
      {/if}
      <li>The admin console will be available once all services are healthy.</li>
      {#if isElectron}
        <li>You can leave this window — we'll let you know when it's ready.</li>
      {:else}
        <li><strong>Keep this tab open while installation runs.</strong></li>
      {/if}
    </ul>
  </aside>
{/if}

{#if deployDone}
  <div class="done-state" id="deploy-done">
    <div class="done-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--s-moss)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
    </div>
    <h2>{deployHasWarnings ? 'Setup Complete (with warnings)' : 'Setup Complete'}</h2>
    {#if noStartMode}
      <p class="done-subtitle">Configuration saved. Run 'openpalm start' to start services.</p>
    {:else}
      <p class="done-subtitle">
        {deployHasWarnings
          ? 'Setup is complete. Some services are still warming up in the background.'
          : 'Your OpenPalm stack is up and running.'}
      </p>
      {#if deployHasWarnings && warningRows.length > 0}
        <div class="deploy-warnings-note" role="status" id="deploy-warnings-note">
          Still warming up: {warningRows.map((s) => s.label || s.service).join(', ')}. You can finish setup now — these will be ready shortly.
        </div>
      {/if}
      {#if deployData.imageWarning}
        <div class="feedback feedback--warning" role="status" id="deploy-image-warning" style="margin-top:12px">
          <span>⚠ {deployData.imageWarning}</span>
        </div>
      {/if}
      {#if !isElectron}
        <p class="done-close-hint">Setup is complete. You can safely close this tab now.</p>
      {/if}
      <ul class="service-list" id="deploy-service-list">
        {#each services as svc}
          {@const name = svc.service || svc.label || ''}
          {@const linkInfo = serviceLinks[name]}
          {@const isWarming = svc.status === 'warning'}
          <li>
            {#if linkInfo}
              {@const url = 'http://127.0.0.1:' + linkInfo.port + linkInfo.path}
              <span class="deploy-svc-name">{linkInfo.label}</span>
              <a href={url} target="_blank" rel="noopener" class="deploy-svc-link">{url}</a>
              <span class="deploy-svc-status">{isWarming ? (svc.label || '⚠ Warming up') : '✓ Running'}</span>
            {:else}
              <span class="deploy-svc-name">{name}</span>
              <span class="deploy-svc-status">{isWarming ? (svc.label || '⚠ Warming up') : '✓ Running'}</span>
            {/if}
          </li>
        {/each}
      </ul>
      <div class="done-links">
        <!-- Same-origin admin nav uses RELATIVE paths so the user stays on the
             exact host they loaded the UI from (127.0.0.1 in the desktop app).
             Navigating to a different host alias (localhost vs 127.0.0.1) would
             drop the session cookie, which is scoped per-host. -->
        <a href="/chat" class="btn btn-primary">Open Chat</a>
        <a href="http://127.0.0.1:{assistantPort}" target="_blank" rel="noopener" class="btn btn-secondary">OpenCode UI</a>
        <a href="/" class="btn btn-secondary">Admin Dashboard</a>
      </div>
    {/if}
  </div>
{/if}

{#if deployError}
  <div class="step-actions" id="deploy-error-actions">
    <button class="btn btn-secondary" id="btn-deploy-back" onclick={onback}>Back to Review</button>
    <button class="btn btn-primary" id="btn-deploy-retry" onclick={onretry}>Retry</button>
  </div>
{/if}

<style>
  /* Warning bar variant — wizard.css ships complete/ready/stopped/indeterminate
     but no `warning`. Voice-warming rows render distinctly (amber, settled —
     NOT the animated indeterminate "still working" bar, and NOT the red error
     bar). Uses the same amber tokens as the existing ready/stopped variants. */
  .deploy-bar-fill.warning {
    width: 72%;
    background: var(--s-ink-2);
    animation: none;
    opacity: 0.9;
  }

  .deploy-warnings-note {
    margin: 12px 0;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--s-ink) 4%, var(--s-paper));
    border: var(--s-hair) solid var(--s-line);
    border-radius: 8px;
    color: var(--s-ink-2);
    font-size: var(--s-type-deed);
    text-align: left;
  }

  .done-close-hint {
    margin: 8px 0 12px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--s-moss) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--s-moss) 25%, transparent);
    border-radius: 6px;
    color: var(--s-moss);
    font-size: var(--s-type-deed);
  }
</style>
