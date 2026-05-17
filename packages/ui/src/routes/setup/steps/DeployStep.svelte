<script lang="ts">
  interface ServiceStatus {
    service: string;
    status: string;
    label?: string;
  }

  interface DeployData {
    deploying?: boolean;
    setupComplete?: boolean;
    deployStatus?: ServiceStatus[];
    deployError?: string | null;
  }

  interface Props {
    deployData: DeployData;
    deployDone: boolean;
    deployError: string | null;
    onback: () => void;
    onretry: () => void;
  }

  let { deployData, deployDone, deployError, onback, onretry }: Props = $props();

  const SERVICE_LINKS: Record<string, { port: number; label: string; path: string }> = {
    assistant: { port: 3800, label: 'Assistant (Chat)', path: '' },
    admin: { port: 3880, label: 'Admin Dashboard', path: '' },
    guardian: { port: 3899, label: 'Guardian', path: '/health' },
  };

  const services = $derived(deployData.deployStatus ?? []);
  const total = $derived(services.length);
  const running = $derived(services.filter((s) => s.status === 'running').length);
  const pct = $derived(total > 0 ? Math.round((running / total) * 100) : 0);

  const deployTitle = $derived.by(() => {
    if (deployDone) return 'Setup Complete';
    if (deployError) return 'Deployment Issue';
    if (pct > 0 && pct < 100) return 'Starting Services...';
    const ready = services.filter((s) => s.status === 'running' || s.status === 'ready').length;
    if (ready > 0 && running === 0) return 'Pulling Images...';
    return 'Deploying...';
  });

  const deploySubtitle = $derived.by(() => {
    if (deployDone) return 'Your OpenPalm stack is up and running.';
    if (deployError) return 'Setup could not finish starting the stack.';
    if (pct > 0 && pct < 100) return `${running} of ${total} services running.`;
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </span>
        {:else if svc.status === 'error'}
          <span class="deploy-warning">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v4"/><path d="M12 17h.01"/>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            </svg>
          </span>
        {:else}
          <span class="deploy-spinner"><span class="spinner"></span></span>
        {/if}
      </div>
      <div class="deploy-service-info">
        <span class="deploy-service-name">{svc.service || svc.label || ''}</span>
        <span class="deploy-service-status">{svc.label || svc.status}</span>
      </div>
      <div class="deploy-service-bar">
        <div class="deploy-bar-fill {svc.status === 'running' ? 'complete' : svc.status === 'ready' ? 'ready' : svc.status === 'error' ? 'stopped' : 'indeterminate'}">
        </div>
      </div>
    </div>
  {/each}
</div>

{#if deployError}
  <div class="deploy-failure-card" id="deploy-failure" role="alert">
    <div class="deploy-failure-header">
      <span class="deploy-failure-kicker">Error</span>
      <h3 id="deploy-failure-title">Deployment failed</h3>
    </div>
    <p class="deploy-failure-summary" id="deploy-failure-summary">
      {typeof deployError === 'string' ? deployError : 'Deployment failed.'}
    </p>
    <details class="deploy-error-details">
      <summary>Technical details</summary>
      <pre id="deploy-error-pre">{typeof deployError === 'string' ? deployError : JSON.stringify(deployError, null, 2)}</pre>
    </details>
  </div>
{/if}

{#if !deployDone && !deployError}
  <aside class="deploy-tips" id="deploy-tips">
    <div class="deploy-tips-header">
      <span class="deploy-tips-kicker">Tips</span>
      <h3>First startup takes a few minutes</h3>
    </div>
    <ul>
      <li>Container images are being downloaded for the first time.</li>
      <li>The admin console will be available once all services are healthy.</li>
      <li>You can close this page; setup will continue in the background.</li>
    </ul>
  </aside>
{/if}

{#if deployDone}
  <div class="done-state" id="deploy-done">
    <div class="done-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
    </div>
    <h2>Setup Complete</h2>
    {#if noStartMode}
      <p class="done-subtitle">Configuration saved. Run 'openpalm start' to start services.</p>
    {:else}
      <p class="done-subtitle">Your OpenPalm stack is up and running.</p>
      <ul class="service-list" id="deploy-service-list">
        {#each services as svc}
          {@const name = svc.service || svc.label || ''}
          {@const linkInfo = SERVICE_LINKS[name]}
          <li>
            {#if linkInfo}
              {@const url = 'http://localhost:' + linkInfo.port + linkInfo.path}
              <span class="deploy-svc-name">{linkInfo.label}</span>
              <a href={url} target="_blank" rel="noopener" class="deploy-svc-link">{url}</a>
              <span class="deploy-svc-status">✓ Running</span>
            {:else}
              <span class="deploy-svc-name">{name}</span>
              <span class="deploy-svc-status">✓ Running</span>
            {/if}
          </li>
        {/each}
      </ul>
      <a href="http://localhost:3800" class="btn btn-primary">Open Chat</a>
    {/if}
  </div>
{/if}

{#if deployError}
  <div class="step-actions" id="deploy-error-actions">
    <button class="btn btn-secondary" id="btn-deploy-back" onclick={onback}>Back to Review</button>
    <button class="btn btn-primary" id="btn-deploy-retry" onclick={onretry}>Retry</button>
  </div>
{/if}
