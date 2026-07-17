<script lang="ts" module>
  // Unique-id counter so each ToolLog instance gets a stable, non-colliding
  // heading id (the component renders in both the wide rail and the drawer).
  let uid = 0;
</script>

<script lang="ts">
  import {
    type ToolStripEntry,
    timelineTitle,
    displayTitle,
    relativeTimeLabel,
    toolIconType,
    toolAriaLabel,
    toolOutcome,
    toolStatusLabel,
    toolDetailRows,
  } from '$lib/chat/tool-strip.js';
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
  }

  let { items }: Props = $props();

  // Stable heading id for aria-labelledby (UX-05).
  uid += 1;
  const headingId = `tool-log-heading-${uid}`;

  // Expanded rows keyed by tool id. Survives the pending→captured transition
  // because the id is stable (OpenCode callID).
  let expanded = $state<Record<string, boolean>>({});

  function toggle(id: string): void {
    expanded = { ...expanded, [id]: !expanded[id] };
  }

  // True when this item begins a new user turn (different turnKey from the
  // previous item). Graceful no-op when turnKeys are absent (UX-26).
  function startsNewTurn(index: number): boolean {
    if (index <= 0) return false;
    const current = items[index].turnKey;
    const previous = items[index - 1].turnKey;
    if (current === undefined || previous === undefined) return false;
    return current !== previous;
  }

  const statusAnnouncement = $derived(
    items
      .map((tool) => `${displayTitle(tool)}: ${toolStatusLabel(tool)}`)
      .join(', '),
  );
</script>

{#if items.length > 0}
  <section class="tool-log" aria-labelledby={headingId}>
    <h2 class="tool-log-heading" id={headingId}>activity</h2>

    <div
      class="tool-log-live"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-relevant="text"
    >
      {statusAnnouncement}
    </div>

    <ul class="tool-log-list">
      {#each items as tool, i (tool.id)}
        {@const open = !!expanded[tool.id]}
        {@const outcome = toolOutcome(tool)}
        {@const iconType = toolIconType(tool.tool, outcome)}
        {@const running = outcome === 'running'}
        {@const failed = outcome === 'failed'}
        {@const warning = outcome === 'warning'}
        {@const stopped = outcome === 'stopped'}
        {@const uncertain = outcome === 'uncertain'}
        {@const when = relativeTimeLabel(tool.updatedAt)}
        {@const detailsId = `${headingId}-details-${i}`}
        <li
          class="tool-log-item"
          class:running
          class:failed
          class:warning
          class:stopped
          class:uncertain
          class:new-turn={startsNewTurn(i)}
        >
          <button
            class="tool-log-summary"
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={toolAriaLabel(tool)}
            title={timelineTitle(tool)}
            onclick={() => toggle(tool.id)}
          >
            <span class="tool-log-icon" aria-hidden="true">
              {#if iconType === 'alert'}
                <IconAlert size={15} />
              {:else if iconType === 'done-circle'}
                <IconDoneCircle size={15} />
              {:else if iconType === 'refresh'}
                <IconRefresh size={15} />
              {:else if iconType === 'terminal'}
                <IconTerminal size={15} />
              {:else if iconType === 'search'}
                <IconSearch size={15} />
              {:else if iconType === 'file'}
                <IconFile size={15} />
              {:else if iconType === 'edit'}
                <IconEdit size={15} />
              {:else if iconType === 'link'}
                <IconLink size={15} />
              {:else if iconType === 'agent'}
                <IconAgent size={15} />
              {:else if iconType === 'done'}
                <IconDone size={15} />
              {:else}
                <IconClock size={15} />
              {/if}
            </span>

            <span class="tool-log-main">
              <span class="tool-log-title">{displayTitle(tool)}</span>
              {#if when}
                <span class="tool-log-time">{when}</span>
              {/if}
            </span>

            <span class="tool-log-status" aria-hidden="true">{toolStatusLabel(tool)}</span>

            <span class="tool-log-chevron" class:open aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path
                  d="M3 4.5 6 7.5 9 4.5"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </button>

          {#if open}
            <div class="tool-log-details" id={detailsId} role="region" aria-label={toolAriaLabel(tool)}>
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
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    min-width: 0;
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
    color: var(--s-ink-2);
  }

  /* Visually-hidden live region for failure announcements (UX-29). */
  .tool-log-live {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  .tool-log-list {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .tool-log-item {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    border-left: var(--s-hair) solid var(--s-line-soft);
    transition: border-color var(--s-t-quick) var(--s-ease);
  }

  /* Per-turn separator: a small gap + hairline above a new turn (UX-26). */
  .tool-log-item.new-turn {
    margin-top: var(--s-sp-2);
    border-top: var(--s-hair) solid var(--s-line-soft);
    padding-top: var(--s-sp-1);
  }

  .tool-log-item.running {
    border-left-color: var(--s-seal);
  }

  /* Failure is the most prominent state (UX-11). */
  .tool-log-item.failed {
    border-left-color: var(--s-error);
  }

  .tool-log-item.warning,
  .tool-log-item.uncertain {
    border-left-color: var(--s-seal);
  }

  .tool-log-item.uncertain {
    border-left-style: dashed;
  }

  .tool-log-summary {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    width: 100%;
    max-width: 100%;
    min-width: 0;
    min-height: 48px;
    appearance: none;
    border: 0;
    background: none;
    cursor: pointer;
    text-align: left;
    padding: var(--s-sp-2) var(--s-sp-2) var(--s-sp-2) var(--s-sp-3);
    color: var(--s-ink-2);
    border-radius: var(--s-radius-sm, 4px);
    transition:
      color var(--s-t-quick) var(--s-ease),
      background-color var(--s-t-quick) var(--s-ease);
  }

  /* Rows read as interactive (UX-23). */
  .tool-log-summary:hover {
    color: var(--s-ink);
    background-color: var(--s-bg-hover, rgba(127, 127, 127, 0.08));
  }

  .tool-log-summary:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: -2px;
  }

  .tool-log-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--s-ink-2); /* lifted from ink-3 (UX-24) */
    flex-shrink: 0;
  }

  .tool-log-item.running .tool-log-icon {
    color: var(--s-seal);
  }

  .tool-log-item.failed .tool-log-icon {
    color: var(--s-error);
  }

  .tool-log-item.warning .tool-log-icon,
  .tool-log-item.uncertain .tool-log-icon {
    color: var(--s-seal);
  }

  /* Subtle pulse on the running icon (UX-11). */
  .tool-log-item.running .tool-log-icon {
    animation: tool-log-pulse 1.4s var(--s-ease) infinite;
  }

  @keyframes tool-log-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  .tool-log-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .tool-log-title {
    min-width: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    line-height: 1.4;
    /* Wrap up to two lines instead of truncating to identical prefixes (UX-04). */
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }

  /* Unobtrusive relative timestamp under the title (UX-14). */
  .tool-log-time {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }

  .tool-log-status {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-2);
    flex-shrink: 0;
  }

  .tool-log-item.running .tool-log-status {
    color: var(--s-seal);
  }

  .tool-log-item.failed .tool-log-status {
    color: var(--s-error);
  }

  .tool-log-item.warning .tool-log-status,
  .tool-log-item.uncertain .tool-log-status {
    color: var(--s-seal);
  }

  /* Fixed-width trailing column so the chevron forms a clean vertical edge
     regardless of the (now rare) status badge width (UX-27). */
  .tool-log-chevron {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    width: 16px;
    color: var(--s-ink-2); /* higher contrast affordance (UX-23) */
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
    color: var(--s-ink-2); /* lifted from ink-3 for AA contrast (UX-12) */
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
    color: var(--s-error);
  }

  /* Respect reduced-motion: disable chevron rotation + running pulse (UX-22). */
  @media (prefers-reduced-motion: reduce) {
    .tool-log-chevron {
      transition: none;
    }
    .tool-log-item.running .tool-log-icon {
      animation: none;
    }
  }
</style>
