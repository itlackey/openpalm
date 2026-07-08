<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '@openpalm/ui-kit/components/common/Spinner.svelte';
  import EmptyState from '@openpalm/ui-kit/components/common/EmptyState.svelte';
  import Panel from '@openpalm/ui-kit/components/common/Panel.svelte';
  import { fetchServiceLogs, fetchAutomationLog } from '$lib/api.js';

  interface Props {
    services: string[];
    automations: string[];
  }

  let { services, automations }: Props = $props();

  let logs = $state('');
  let logsLoaded = $state(false);
  let loading = $state(false);
  let error = $state('');
  let source = $state<'services' | 'routines'>('services');
  let selectedService = $state('');
  let selectedAutomation = $state('');
  let tailLines = $state(100);
  let autoScroll = $state(true);
  let copied = $state(false);

  let logContainer: HTMLPreElement | undefined = $state();

  async function loadLogs(): Promise<void> {
    loading = true;
    error = '';
    try {
      if (source === 'services') {
        const result = await fetchServiceLogs({
          service: selectedService || undefined,
          tail: tailLines,
        });
        if (result.ok) {
          logs = result.logs;
          logsLoaded = true;
          if (autoScroll && logContainer) {
            requestAnimationFrame(() => {
              if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
            });
          }
        } else {
          error = result.error ?? 'Failed to fetch logs.';
        }
      } else {
        if (!selectedAutomation && automations.length > 0) {
          selectedAutomation = automations[0] ?? '';
        }
        if (!selectedAutomation) {
          logs = '';
          logsLoaded = true;
          return;
        }
        const result = await fetchAutomationLog(selectedAutomation, tailLines);
        logs = result.lines.join('\n');
        logsLoaded = true;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to fetch logs.';
    } finally {
      loading = false;
    }
  }

  async function copyLogs(): Promise<void> {
    if (!logs) return;
    await navigator.clipboard.writeText(logs);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }

  onMount(() => {
    void loadLogs();
  });

  function switchSource(next: 'services' | 'routines'): void {
    source = next;
    error = '';
    logs = '';
    logsLoaded = false;
    if (next === 'routines' && !selectedAutomation) {
      selectedAutomation = automations[0] ?? '';
    }
    void loadLogs();
  }
</script>

<Panel title="Journal" role="tabpanel">
  {#snippet actions()}
    <button class="btn btn-secondary btn-sm" onclick={() => void copyLogs()} disabled={!logs}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
    <button class="btn btn-secondary btn-sm" onclick={() => void loadLogs()} disabled={loading}>
      {#if loading}
        <Spinner />
      {/if}
      Refresh
    </button>
  {/snippet}

  <div class="controls">
    <div class="control-group control-group--source">
      <span class="control-label">Source</span>
      <div class="source-switch" role="tablist" aria-label="Journal source">
        <button
          class="source-pill"
          class:source-pill--active={source === 'services'}
          type="button"
          role="tab"
          aria-selected={source === 'services'}
          onclick={() => switchSource('services')}
        >Service logs</button>
        <button
          class="source-pill"
          class:source-pill--active={source === 'routines'}
          type="button"
          role="tab"
          aria-selected={source === 'routines'}
          onclick={() => switchSource('routines')}
        >Routine logs</button>
      </div>
    </div>

    {#if source === 'services'}
    <div class="control-group">
      <label for="log-service" class="control-label">Service</label>
      <select id="log-service" class="control-input" bind:value={selectedService} onchange={() => void loadLogs()}>
        <option value="">All services</option>
        {#each services as svc (svc)}
          <option value={svc}>{svc}</option>
        {/each}
      </select>
    </div>
    {:else}
    <div class="control-group">
      <label for="log-automation" class="control-label">Routine</label>
      <select id="log-automation" class="control-input" bind:value={selectedAutomation} onchange={() => void loadLogs()}>
        {#if automations.length === 0}
          <option value="">No routines yet</option>
        {:else}
          {#each automations as automation (automation)}
            <option value={automation}>{automation}</option>
          {/each}
        {/if}
      </select>
    </div>
    {/if}

    <div class="control-group">
      <label for="log-tail" class="control-label">Recent lines</label>
      <select id="log-tail" class="control-input" bind:value={tailLines} onchange={() => void loadLogs()}>
        <option value={50}>50</option>
        <option value={100}>100</option>
        <option value={250}>250</option>
        <option value={500}>500</option>
        <option value={1000}>1000</option>
      </select>
    </div>

    {#if source === 'services'}
      <div class="control-group control-group--toggle">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={autoScroll} />
          <span>Auto-scroll</span>
        </label>
      </div>
    {/if}

    <button class="btn btn-primary btn-sm" onclick={() => void loadLogs()} disabled={loading}>
      {#if loading}
        <Spinner />
      {/if}
      {source === 'services' ? 'Load service logs' : 'Load routine log'}
    </button>
  </div>

  <div class="panel-body panel-body--flush">
    {#if error}
      <div class="error-banner">
        <span>{error}</span>
      </div>
    {/if}

    {#if logs}
      <pre class="log-output" bind:this={logContainer}>{logs}</pre>
    {:else if !loading}
      <EmptyState>
        {#snippet icon()}
          <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        {/snippet}
        {#if logsLoaded}
          {#if source === 'services'}
            <p>No log output — the container may not be running or has no recent output.</p>
          {:else}
            <p>No routine output yet.</p>
          {/if}
        {:else}
          {#if source === 'services'}
            <p>Select a service and click "Load service logs" to view container output.</p>
          {:else}
            <p>Select a routine and click "Load routine log" to view its latest output.</p>
          {/if}
        {/if}
      </EmptyState>
    {/if}
  </div>
</Panel>

<style>
  /* ── Controls ─────────────────────────────────────────────────── */

  .controls {
    display: flex;
    align-items: flex-end;
    gap: var(--s-sp-4);
    padding: var(--s-sp-4) var(--s-sp-6);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    background: var(--s-paper-deep);
    flex-wrap: wrap;
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
  }

  .control-group--toggle {
    justify-content: flex-end;
  }

  .control-group--source {
    min-width: 16rem;
  }

  .control-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .control-input {
    height: 32px;
    padding: 0 var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
    color: var(--s-ink);
    font-family: var(--s-font-display);
    font-size: var(--s-type-mark);
    min-width: 140px;
  }

  .control-input:focus {
    outline: none;
    border-color: var(--s-ink-2);
  }

  .source-switch {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-1);
    padding: 4px;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
  }

  .source-pill {
    min-height: 32px;
    padding: 0 var(--s-sp-3);
    border: none;
    border-radius: 2px;
    background: transparent;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    cursor: pointer;
  }

  .source-pill:hover {
    background: color-mix(in srgb, var(--s-ink) 4%, var(--s-paper));
    color: var(--s-ink-2);
  }

  .source-pill--active {
    background: var(--s-paper-deep);
    color: var(--s-ink);
    border: var(--s-hair) solid var(--s-line);
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    cursor: pointer;
    height: 32px;
  }

  /* ── Log Output ───────────────────────────────────────────────── */

  .log-output {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    line-height: 1.7;
    color: var(--s-ink-2);
    background: color-mix(in srgb, var(--s-ink) 3%, var(--s-paper));
    border: var(--s-hair) solid var(--s-line-soft);
    padding: var(--s-sp-4);
    margin: 0;
    white-space: pre;
    overflow-y: auto;
    max-height: 600px;
    tab-size: 4;
  }

  /* ── Error ────────────────────────────────────────────────────── */

  .error-banner {
    padding: var(--s-sp-3) var(--s-sp-6);
    border-bottom: var(--s-hair) solid var(--s-error);
    color: var(--s-error);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
  }

  @media (max-width: 768px) {
    .controls {
      flex-direction: column;
      align-items: stretch;
    }

    .control-input {
      min-width: unset;
      width: 100%;
    }

    .source-switch {
      width: 100%;
    }

    .source-pill {
      flex: 1;
    }

    .log-output {
      max-height: 400px;
    }
  }
</style>
