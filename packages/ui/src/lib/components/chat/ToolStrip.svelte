<script lang="ts">
  import type { ToolStripEntry } from '$lib/chat/tool-strip.js';

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

  function toolEmoji(tool: string, status: string): string {
    const name = tool.toLowerCase();
    if (status === 'error' || status === 'failed') return '⚠️';
    if (name === 'step') return status === 'completed' ? '🧩' : '🔄';
    if (name.includes('bash') || name.includes('shell') || name.includes('command')) return '🛠️';
    if (name.includes('grep') || name.includes('search')) return '🔎';
    if (name.includes('read') || name.includes('file')) return '📄';
    if (name.includes('edit') || name.includes('write') || name.includes('patch')) return '✍️';
    if (name.includes('web') || name.includes('http') || name.includes('fetch')) return '🌐';
    if (name.includes('task') || name.includes('agent')) return '🤖';
    return status === 'completed' ? '✅' : '⏳';
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
      <button
        class="tool-emoji-btn"
        class:selected={selectedToolId === tool.id}
        type="button"
        aria-label={toolAriaLabel(tool)}
        title={toolAriaLabel(tool)}
        onclick={() => openToolDetails(tool.id)}
      >
        <span class="tool-emoji" aria-hidden="true">{toolEmoji(tool.tool, tool.status)}</span>
      </button>
    {/each}
  </div>
{/if}

{#if selectedToolEntry()}
  {@const activeTool = selectedToolEntry()!}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tool-modal-scrim" onclick={closeToolDetails}></div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
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
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
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
    gap: var(--space-2);
  }

  .tool-strip-muted {
    opacity: 0.78;
  }

  .tool-strip-bordered {
    padding-top: var(--space-2);
    border-top: 1px solid var(--color-border);
  }

  .tool-emoji {
    display: block;
    font-size: 1rem;
    text-align: center;
  }

  .tool-emoji-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg);
    color: inherit;
    cursor: pointer;
    transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
  }

  .tool-emoji-btn:hover {
    transform: translateY(-1px);
    border-color: var(--color-text-secondary);
    background: var(--color-bg-secondary);
  }

  .tool-emoji-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .tool-emoji-btn.selected {
    border-color: var(--color-primary);
    background: var(--color-primary-subtle);
  }

  .tool-modal-scrim {
    position: fixed;
    inset: 0;
    z-index: 210;
    background: rgba(0, 0, 0, 0.45);
  }

  .tool-modal-shell {
    position: fixed;
    inset: 0;
    z-index: 211;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    pointer-events: none;
  }

  .tool-modal {
    width: min(42rem, 100%);
    max-height: min(80vh, 48rem);
    overflow: auto;
    pointer-events: auto;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.24);
  }

  .tool-modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4);
    border-bottom: 1px solid var(--color-border);
  }

  .tool-modal-header-copy {
    min-width: 0;
  }

  .tool-modal-kicker {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-tertiary);
  }

  .tool-modal-title {
    margin: 4px 0 0;
    font-size: var(--text-lg);
    color: var(--color-text);
  }

  .tool-modal-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .tool-modal-close:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .tool-modal-close:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .tool-modal-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
  }

  .tool-modal-row {
    display: grid;
    grid-template-columns: minmax(7rem, 9rem) minmax(0, 1fr);
    gap: var(--space-3);
    align-items: start;
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--color-border);
  }

  .tool-modal-row:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }

  .tool-modal-label {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-tertiary);
  }

  .tool-modal-value {
    min-width: 0;
    color: var(--color-text);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .tool-inline-error {
    color: var(--color-danger);
  }

  .tool-modal-value pre {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-pre-error {
    color: var(--color-danger);
  }

  @media (max-width: 640px) {
    .tool-modal-row {
      grid-template-columns: 1fr;
      gap: var(--space-1);
    }
  }
</style>
