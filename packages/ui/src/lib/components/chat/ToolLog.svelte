<script lang="ts">
  import {
    type ToolStripEntry,
    timelineTitle,
    toolIconType,
    toolAriaLabel,
    toolStatusLabel,
    toolDetailRows,
  } from '$lib/chat/tool-strip.js';
  import IconAlert from '$lib/components/icons/IconAlert.svelte';
  import IconRefresh from '$lib/components/icons/IconRefresh.svelte';
  import IconDoneCircle from '$lib/components/icons/IconDoneCircle.svelte';
  import IconTerminal from '$lib/components/icons/IconTerminal.svelte';
  import IconSearch from '$lib/components/icons/IconSearch.svelte';
  import IconFile from '$lib/components/icons/IconFile.svelte';
  import IconEdit from '$lib/components/icons/IconEdit.svelte';
  import IconLink from '$lib/components/icons/IconLink.svelte';
  import IconAgent from '$lib/components/icons/IconAgent.svelte';
  import IconDone from '$lib/components/icons/IconDone.svelte';
  import IconClock from '$lib/components/icons/IconClock.svelte';

  interface Props {
    items: ToolStripEntry[];
    ariaLabel?: string;
  }

  let { items, ariaLabel = 'Assistant activity' }: Props = $props();

  // Expanded rows keyed by tool id. Survives the pending→captured transition
  // because the id is stable (OpenCode callID).
  let expanded = $state<Record<string, boolean>>({});

  function toggle(id: string): void {
    expanded = { ...expanded, [id]: !expanded[id] };
  }

  function isRunning(status: string): boolean {
    return status !== 'completed' && status !== 'error' && status !== 'failed';
  }
</script>

{#if items.length > 0}
  <section class="tool-log" aria-label={ariaLabel}>
    <h2 class="tool-log-heading">activity</h2>
    <ul class="tool-log-list">
      {#each items as tool (tool.id)}
        {@const iconType = toolIconType(tool.tool, tool.status)}
        {@const open = !!expanded[tool.id]}
        <li
          class="tool-log-item"
          class:running={isRunning(tool.status)}
          class:failed={tool.status === 'error' || tool.status === 'failed'}
        >
          <button
            class="tool-log-summary"
            type="button"
            aria-expanded={open}
            aria-label={toolAriaLabel(tool)}
            onclick={() => toggle(tool.id)}
          >
            <span class="tool-log-icon" aria-hidden="true">
              {#if iconType === 'alert'}
                <IconAlert size={13} />
              {:else if iconType === 'done-circle'}
                <IconDoneCircle size={13} />
              {:else if iconType === 'refresh'}
                <IconRefresh size={13} />
              {:else if iconType === 'terminal'}
                <IconTerminal size={13} />
              {:else if iconType === 'search'}
                <IconSearch size={13} />
              {:else if iconType === 'file'}
                <IconFile size={13} />
              {:else if iconType === 'edit'}
                <IconEdit size={13} />
              {:else if iconType === 'link'}
                <IconLink size={13} />
              {:else if iconType === 'agent'}
                <IconAgent size={13} />
              {:else if iconType === 'done'}
                <IconDone size={13} />
              {:else}
                <IconClock size={13} />
              {/if}
            </span>
            <span class="tool-log-title">{timelineTitle(tool)}</span>
            <span class="tool-log-status">{toolStatusLabel(tool.status)}</span>
            <span class="tool-log-chevron" class:open aria-hidden="true">
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <path
                  d="M3 4.5 6 7.5 9 4.5"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </button>

          {#if open}
            <div class="tool-log-details">
              {#each toolDetailRows(tool) as row (`${tool.id}:${row.label}`)}
                <div class="tool-log-row">
                  <div class="tool-log-label">{row.label}</div>
                  <div class="tool-log-value">
                    {#if row.value.includes('\n') || row.value.length > 80}
                      <pre class:tool-log-error={row.tone === 'error'}>{row.value}</pre>
                    {:else}
                      <div class:tool-log-error={row.tone === 'error'}>{row.value}</div>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .tool-log {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
  }

  .tool-log-heading {
    margin: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    font-weight: 400;
    letter-spacing: 0.26em;
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .tool-log-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .tool-log-item {
    border-left: var(--s-hair) solid var(--s-line-soft);
    transition: border-color var(--s-t-quick) var(--s-ease);
  }

  .tool-log-item.running {
    border-left-color: var(--s-seal);
  }

  .tool-log-item.failed {
    border-left-color: var(--s-seal);
  }

  .tool-log-summary {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    width: 100%;
    appearance: none;
    border: 0;
    background: none;
    cursor: pointer;
    text-align: left;
    padding: var(--s-sp-2) var(--s-sp-2) var(--s-sp-2) var(--s-sp-3);
    color: var(--s-ink-2);
    transition: color var(--s-t-quick) var(--s-ease);
  }

  .tool-log-summary:hover {
    color: var(--s-ink);
  }

  .tool-log-summary:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: -2px;
  }

  .tool-log-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--s-ink-3);
    flex-shrink: 0;
  }

  .tool-log-item.running .tool-log-icon,
  .tool-log-item.failed .tool-log-icon {
    color: var(--s-seal);
  }

  .tool-log-title {
    flex: 1;
    min-width: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-log-status {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    flex-shrink: 0;
  }

  .tool-log-item.running .tool-log-status,
  .tool-log-item.failed .tool-log-status {
    color: var(--s-seal);
  }

  .tool-log-chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--s-ink-3);
    flex-shrink: 0;
    transition: transform var(--s-t-quick) var(--s-ease);
  }

  .tool-log-chevron.open {
    transform: rotate(180deg);
  }

  .tool-log-details {
    display: flex;
    flex-direction: column;
    padding: 0 var(--s-sp-2) var(--s-sp-3) var(--s-sp-3);
  }

  .tool-log-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-bottom: var(--s-sp-2);
    margin-bottom: var(--s-sp-2);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }

  .tool-log-row:last-child {
    padding-bottom: 0;
    margin-bottom: 0;
    border-bottom: 0;
  }

  .tool-log-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }

  .tool-log-value {
    min-width: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-2);
    line-height: 1.5;
    word-break: break-word;
  }

  .tool-log-value pre {
    margin: 0;
    padding: var(--s-sp-1) 0 0;
    background: none;
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-log-error {
    color: var(--s-seal);
  }
</style>
