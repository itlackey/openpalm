<script lang="ts">
  import {
    type ToolStripEntry,
    timelineTitle,
    toolIconType,
    toolKindLabel,
    toolAriaLabel,
    toolDetailRows,
  } from '$lib/chat/tool-strip.js';
  import { createFocusTrap, handleTrapKeydown } from '$lib/actions/focus-trap.js';
  import IconClose from '@openpalm/ui-kit/components/icons/IconClose.svelte';
  import IconAlert from '@openpalm/ui-kit/components/icons/IconAlert.svelte';
  import IconRefresh from '@openpalm/ui-kit/components/icons/IconRefresh.svelte';
  import IconDoneCircle from '@openpalm/ui-kit/components/icons/IconDoneCircle.svelte';
  import IconTerminal from '@openpalm/ui-kit/components/icons/IconTerminal.svelte';
  import IconSearch from '@openpalm/ui-kit/components/icons/IconSearch.svelte';
  import IconFile from '@openpalm/ui-kit/components/icons/IconFile.svelte';
  import IconEdit from '@openpalm/ui-kit/components/icons/IconEdit.svelte';
  import IconLink from '@openpalm/ui-kit/components/icons/IconLink.svelte';
  import IconAgent from '@openpalm/ui-kit/components/icons/IconAgent.svelte';
  import IconDone from '@openpalm/ui-kit/components/icons/IconDone.svelte';
  import IconClock from '@openpalm/ui-kit/components/icons/IconClock.svelte';

  interface Props {
    items: ToolStripEntry[];
    muted?: boolean;
    bordered?: boolean;
    ariaLabel?: string;
  }

  let {
    items,
    muted = false,
    bordered = false,
    ariaLabel = 'Assistant tool activity',
  }: Props = $props();

  let selectedToolId = $state<string | null>(null);

  // Shared focus-trap primitives (WCAG 2.4.3 / APG dialog): move focus into the
  // modal on open, restore it on close, and trap Tab / handle Escape.
  const manageToolModalFocus = createFocusTrap();

  function openToolDetails(id: string): void {
    selectedToolId = id;
  }

  function closeToolDetails(): void {
    selectedToolId = null;
  }

  function selectedToolEntry(): ToolStripEntry | null {
    if (!selectedToolId) return null;
    return items.find((entry) => entry.id === selectedToolId) ?? null;
  }
</script>

{#if items.length > 0}
  <div class="tool-strip" class:tool-strip-muted={muted} class:tool-strip-bordered={bordered} aria-label={ariaLabel}>
    {#each items as tool (tool.id)}
      {@const toolType = toolIconType(tool.tool, tool.status)}
      <button
        class="tool-icon-btn"
        class:selected={selectedToolId === tool.id}
        type="button"
        aria-label={toolAriaLabel(tool)}
        title={toolAriaLabel(tool)}
        onclick={() => openToolDetails(tool.id)}
      >
        {#if toolType === 'alert'}
          <span class="tool-icon" aria-hidden="true"><IconAlert size={13} /></span>
        {:else if toolType === 'done-circle'}
          <span class="tool-icon" aria-hidden="true"><IconDoneCircle size={13} /></span>
        {:else if toolType === 'refresh'}
          <span class="tool-icon" aria-hidden="true"><IconRefresh size={13} /></span>
        {:else if toolType === 'terminal'}
          <span class="tool-icon" aria-hidden="true"><IconTerminal size={13} /></span>
        {:else if toolType === 'search'}
          <span class="tool-icon" aria-hidden="true"><IconSearch size={13} /></span>
        {:else if toolType === 'file'}
          <span class="tool-icon" aria-hidden="true"><IconFile size={13} /></span>
        {:else if toolType === 'edit'}
          <span class="tool-icon" aria-hidden="true"><IconEdit size={13} /></span>
        {:else if toolType === 'link'}
          <span class="tool-icon" aria-hidden="true"><IconLink size={13} /></span>
        {:else if toolType === 'agent'}
          <span class="tool-icon" aria-hidden="true"><IconAgent size={13} /></span>
        {:else if toolType === 'done'}
          <span class="tool-icon" aria-hidden="true"><IconDone size={13} /></span>
        {:else}
          <span class="tool-icon" aria-hidden="true"><IconClock size={13} /></span>
        {/if}
      </button>
    {/each}
  </div>
{/if}

{#if selectedToolEntry()}
  {@const activeTool = selectedToolEntry()!}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tool-modal-scrim" onclick={closeToolDetails}></div>
  <div class="tool-modal-shell">
    <div
      class="tool-modal"
      role="dialog"
      aria-modal="true"
      aria-label={toolAriaLabel(activeTool)}
      tabindex="-1"
      onkeydown={(event) => handleTrapKeydown(event, closeToolDetails)}
      {@attach manageToolModalFocus}
    >
      <div class="tool-modal-header">
        <div class="tool-modal-header-copy">
          <div class="tool-modal-kicker">{toolKindLabel(activeTool)}</div>
          <h3 class="tool-modal-title">{timelineTitle(activeTool)}</h3>
        </div>
        <button class="tool-modal-close" type="button" onclick={closeToolDetails} aria-label="Close tool details">
          <IconClose size={18} />
        </button>
      </div>

      <div class="tool-modal-grid">
        {#each toolDetailRows(activeTool) as row (`${activeTool.id}:${row.label}`)}
          <div class="tool-modal-row">
            <div class="tool-modal-label">{row.label}</div>
            <div class="tool-modal-value">
              {#if row.value.includes('\n') || row.value.length > 120}
                <pre class:tool-pre-error={row.tone === 'error'}>{row.value}</pre>
              {:else}
                <div class:tool-inline-error={row.tone === 'error'}>{row.value}</div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .tool-strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-sp-2);
    align-items: center;
  }

  .tool-strip-muted {
    opacity: 0.65;
  }

  .tool-strip-bordered {
    padding-top: var(--s-sp-2);
    border-top: var(--s-hair) solid var(--s-line-soft);
  }

  .tool-icon {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tool-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px var(--s-sp-1);
    border: 0;
    border-radius: 0;
    background: none;
    color: var(--s-ink-3);
    cursor: pointer;
    transition: opacity 120ms ease;
  }

  .tool-icon-btn:hover {
    opacity: 0.6;
  }

  .tool-icon-btn:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: 2px;
  }

  .tool-icon-btn.selected {
    text-decoration: underline;
    text-decoration-color: var(--s-seal);
    text-underline-offset: 3px;
  }

  .tool-modal-scrim {
    position: fixed;
    inset: 0;
    z-index: 210;
    background: rgba(0, 0, 0, 0.35);
  }

  .tool-modal-shell {
    position: fixed;
    inset: 0;
    z-index: 211;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--s-sp-6);
    pointer-events: none;
  }

  .tool-modal {
    width: min(42rem, 100%);
    max-height: min(80vh, 48rem);
    overflow: auto;
    pointer-events: auto;
    background: var(--s-paper);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
  }

  .tool-modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-sp-3);
    padding: var(--s-sp-4);
    border-bottom: var(--s-hair) solid var(--s-line);
  }

  .tool-modal-header-copy {
    min-width: 0;
  }

  .tool-modal-kicker {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }

  .tool-modal-title {
    margin: var(--s-sp-1) 0 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    font-weight: 400;
    color: var(--s-ink);
  }

  .tool-modal-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    color: var(--s-ink-3);
    cursor: pointer;
    transition: color 120ms ease;
  }

  .tool-modal-close:hover {
    color: var(--s-ink);
  }

  .tool-modal-close:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: 2px;
  }

  .tool-modal-grid {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: var(--s-sp-4);
  }

  .tool-modal-row {
    display: grid;
    grid-template-columns: minmax(7rem, 9rem) minmax(0, 1fr);
    gap: var(--s-sp-3);
    align-items: start;
    padding-bottom: var(--s-sp-3);
    margin-bottom: var(--s-sp-3);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }

  .tool-modal-row:last-child {
    padding-bottom: 0;
    margin-bottom: 0;
    border-bottom: 0;
  }

  .tool-modal-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }

  .tool-modal-value {
    min-width: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    line-height: 1.5;
  }

  .tool-inline-error {
    color: var(--s-seal);
  }

  .tool-modal-value pre {
    margin: 0;
    padding: var(--s-sp-2) var(--s-sp-3);
    border-left: var(--s-hair) solid var(--s-line);
    background: none;
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-pre-error {
    color: var(--s-seal);
  }

  @media (max-width: 640px) {
    .tool-modal-row {
      grid-template-columns: 1fr;
      gap: var(--s-sp-1);
    }
  }
</style>
