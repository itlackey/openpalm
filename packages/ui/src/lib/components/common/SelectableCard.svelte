<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    icon?: string;
    selected?: boolean;
    verified?: boolean;
    expanded?: boolean;
    status?: 'verifying' | 'error' | null;
    ariaLabel?: string;
    dataId?: string;
    /**
     * Opt-in ARIA role for the card header.
     * - 'button' (default): standard toggle/expander behaviour — announces as button,
     *   uses aria-expanded for expand/collapse state.
     * - 'radio': for cards inside a radiogroup (e.g. the mode-selection cards in
     *   Screen1ModelsStep). Announces as radio, uses aria-checked for selection state.
     *   Does NOT emit aria-expanded.
     */
    selectionRole?: 'button' | 'radio';
    onToggle: () => void;
    titleSuffix?: Snippet;
    children?: Snippet;
  }

  let {
    title,
    description = '',
    icon,
    selected = false,
    verified = false,
    expanded = false,
    status = null,
    ariaLabel,
    dataId,
    selectionRole = 'button',
    onToggle,
    titleSuffix,
    children,
  }: Props = $props();

  let headerEl: HTMLDivElement | null = $state(null);

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(root: Element): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
    );
  }

  function manageExpandedFocus(node: HTMLElement): (() => void) | void {
    const target = focusables(node)[0];
    target?.focus();
    return () => headerEl?.focus();
  }
</script>

<div class:selected class:verified class:wide={expanded} class="selectable-card" data-provider={dataId}>
  <!--
    Two static-role branches avoid Svelte's dynamic-role a11y false-positive.
    'radio': inside a radiogroup — aria-checked tracks selection; no aria-expanded.
    'button' (default): standalone toggle/expander — aria-expanded tracks open state.
  -->
  {#if selectionRole === 'radio'}
    <div
      bind:this={headerEl}
      class="selectable-card-header"
      role="radio"
      tabindex="0"
      aria-checked={selected || verified}
      aria-label={ariaLabel ?? title}
      onclick={onToggle}
      onkeydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onToggle();
      }}
    >
      {#if icon}<div class="selectable-card-icon">{icon}</div>{/if}
      <div class="selectable-card-info">
        <div class="selectable-card-name">
          {title}
          {#if titleSuffix}{@render titleSuffix()}{/if}
          {#if verified}<span class="verification-status verification-status--ok">✓</span>
          {:else if status === 'verifying'}<span class="verification-status verification-status--wait">⟳</span>
          {:else if status === 'error'}<span class="verification-status verification-status--error">✗</span>
          {/if}
        </div>
        {#if description}<div class="selectable-card-desc">{description}</div>{/if}
      </div>
      <div class="selectable-card-radio" class:checked={selected || verified} aria-hidden="true"></div>
    </div>
  {:else}
    <div
      bind:this={headerEl}
      class="selectable-card-header"
      role="button"
      tabindex="0"
      aria-expanded={expanded}
      aria-label={ariaLabel ?? title}
      onclick={onToggle}
      onkeydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onToggle();
      }}
    >
      {#if icon}<div class="selectable-card-icon">{icon}</div>{/if}
      <div class="selectable-card-info">
        <div class="selectable-card-name">
          {title}
          {#if titleSuffix}{@render titleSuffix()}{/if}
          {#if verified}<span class="verification-status verification-status--ok">✓</span>
          {:else if status === 'verifying'}<span class="verification-status verification-status--wait">⟳</span>
          {:else if status === 'error'}<span class="verification-status verification-status--error">✗</span>
          {/if}
        </div>
        {#if description}<div class="selectable-card-desc">{description}</div>{/if}
      </div>
      <div class="selectable-card-check" aria-hidden="true">{selected || verified ? '✓' : ''}</div>
    </div>
  {/if}

  {#if expanded && children}
    <div class="selectable-card-panel" {@attach manageExpandedFocus}>
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .selectable-card {
    border-top: 1px solid var(--color-border);
    padding: 12px 0;
    cursor: pointer;
    transition: background 0.1s;
    overflow: hidden;
    min-width: 0;
  }

  .selectable-card:last-child {
    border-bottom: 1px solid var(--color-border);
  }

  .selectable-card:hover {
    background: var(--color-bg-secondary);
  }

  .selectable-card.selected {
    background: var(--color-primary-subtle);
  }

  .selectable-card.selected .selectable-card-desc {
    color: var(--color-text);
  }

  .selectable-card.verified {
    background: var(--color-success-bg);
  }

  .selectable-card.wide {
    grid-column: 1 / -1;
  }

  .selectable-card-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .selectable-card-header:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .selectable-card-icon {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-md);
    background: var(--color-bg-secondary);
    display: grid;
    place-items: center;
    font-size: 18px;
    flex-shrink: 0;
  }

  .selectable-card-info {
    flex: 1;
    min-width: 0;
  }

  .selectable-card-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .selectable-card-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin-top: 1px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selectable-card-check {
    width: 18px;
    height: 18px;
    border-radius: 6px;
    border: 2px solid var(--color-border);
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 11px;
    color: white;
    transition: all 0.15s;
  }

  .selectable-card.selected .selectable-card-check {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
  }

  .selectable-card.verified .selectable-card-check {
    background: var(--color-success);
    border-color: var(--color-success);
  }

  /* Radio-variant indicator (circle) for single-choice cards */
  .selectable-card-radio {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--color-border);
    flex-shrink: 0;
    position: relative;
    background: var(--color-bg);
    transition: border-color 0.15s;
  }

  .selectable-card-radio.checked {
    border-color: var(--color-primary);
  }

  .selectable-card-radio.checked::after {
    content: '';
    position: absolute;
    inset: 3px;
    border-radius: 50%;
    background: var(--color-primary);
  }

  .verification-status {
    font-size: var(--text-sm);
    flex-shrink: 0;
    margin-left: 2px;
  }

  .verification-status--ok {
    color: var(--color-success);
  }

  .verification-status--error {
    color: var(--color-error);
  }

  .verification-status--wait {
    color: var(--color-primary-hover);
    animation: selectable-card-blink 1.2s ease infinite;
  }

  .selectable-card-panel {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--color-border);
    animation: selectable-card-fade-in 0.2s ease;
  }

  @keyframes selectable-card-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  @keyframes selectable-card-fade-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
