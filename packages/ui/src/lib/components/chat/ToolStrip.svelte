<script lang="ts">
  import type { ToolStripEntry } from '$lib/chat/tool-strip.js';
  import IconClose from '$lib/components/icons/IconClose.svelte';
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

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(root: Element): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
    );
  }

  function manageToolModalFocus(node: HTMLElement): () => void {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const target = focusables(node)[0] ?? node;
    target.focus();
    return () => previouslyFocused?.focus?.();
  }

  function onToolModalKey(event: KeyboardEvent & { currentTarget: HTMLElement }): void {
    if (event.key === 'Escape') {
      closeToolDetails();
      return;
    }

    if (event.key !== 'Tab') return;

    const toolModalItems = focusables(event.currentTarget);
    if (toolModalItems.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }

    const first = toolModalItems[0]!;
    const last = toolModalItems[toolModalItems.length - 1]!;
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openToolDetails(id: string): void {
    selectedToolId = id;
  }

  function closeToolDetails(): void {
    selectedToolId = null;
  }

  function parseStructured(value: string): unknown {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function formatDetail(value: string): string {
    const structured = parseStructured(value);
    return structured === null ? value : JSON.stringify(structured, null, 2);
  }

  function prettyLabel(label: string): string {
    if (!label) return '';
    return label
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^./, (char) => char.toUpperCase());
  }

  function toolIconType(tool: string, status: string): string {
    const name = tool.toLowerCase();
    if (status === 'error' || status === 'failed') return 'alert';
    if (name === 'step') return status === 'completed' ? 'done-circle' : 'refresh';
    if (name.includes('bash') || name.includes('shell') || name.includes('command')) return 'terminal';
    if (name.includes('grep') || name.includes('search')) return 'search';
    if (name.includes('read') || name.includes('file')) return 'file';
    if (name.includes('edit') || name.includes('write') || name.includes('patch')) return 'edit';
    if (name.includes('web') || name.includes('http') || name.includes('fetch')) return 'link';
    if (name.includes('task') || name.includes('agent')) return 'agent';
    return status === 'completed' ? 'done' : 'clock';
  }

  function timelineTitle(entry: ToolStripEntry): string {
    return entry.kind === 'step' ? entry.title : entry.title || entry.tool;
  }

  function toolKindLabel(entry: ToolStripEntry): string {
    return entry.kind === 'step' ? 'Step' : 'Tool';
  }

  function toolStatusLabel(status: string): string {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'error':
      case 'failed':
        return 'failed';
      case 'pending':
        return 'queued';
      default:
        return 'running';
    }
  }

  function toolAriaLabel(entry: ToolStripEntry): string {
    return `${toolKindLabel(entry)}: ${timelineTitle(entry)} (${toolStatusLabel(entry.status)})`;
  }

  function toolDetailRows(entry: ToolStripEntry): Array<{ label: string; value: string; tone?: 'default' | 'error' }> {
    const rows: Array<{ label: string; value: string; tone?: 'default' | 'error' }> = [
      { label: 'Type', value: toolKindLabel(entry) },
      { label: 'Name', value: timelineTitle(entry) },
      { label: 'Status', value: prettyLabel(toolStatusLabel(entry.status)) },
    ];

    if (entry.kind !== 'step') {
      rows.push({ label: 'Tool ID', value: entry.tool });
    }

    if (entry.detail) {
      rows.push({
        label: entry.kind === 'step' ? 'Details' : 'Input / Details',
        value: formatDetail(entry.detail),
      });
    }

    if (entry.output) {
      rows.push({ label: 'Output', value: formatDetail(entry.output) });
    }

    if (entry.error) {
      rows.push({ label: 'Error', value: formatDetail(entry.error), tone: 'error' });
    }

    return rows;
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
      onkeydown={onToolModalKey}
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
