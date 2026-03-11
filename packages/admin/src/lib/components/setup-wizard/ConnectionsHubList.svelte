<script lang="ts">
  import type { WizardConnectionDraft } from '$lib/setup-wizard/state.js';

  interface Props {
    connections: WizardConnectionDraft[];
    emptyHeadline: string;
    emptyBody: string;
    emptyCta: string;
    onEdit: (index: number) => void;
    onDuplicate: (index: number) => void;
    onRemove: (index: number) => void;
    onAdd: () => void;
  }

  let { connections, emptyHeadline, emptyBody, emptyCta, onEdit, onDuplicate, onRemove, onAdd }: Props = $props();
</script>

{#if connections.length === 0}
  <div class="hub-empty">
    <p class="hub-empty-headline">{emptyHeadline}</p>
    <p class="hub-empty-body">{emptyBody}</p>
    <button class="btn btn-primary" type="button" onclick={onAdd}>{emptyCta}</button>
  </div>
{:else}
  <ul class="hub-list" aria-label="Connections">
    {#each connections as conn, i}
      <li class="hub-row">
        <div class="hub-row-info">
          <span class="hub-row-name">{conn.name || conn.provider}</span>
          <span class="hub-row-badge hub-row-type">{conn.connectionType === 'local' ? 'Local' : 'Remote'}</span>
          {#if conn.tested}
            <span class="hub-row-badge hub-row-tested" aria-label="Connection tested">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
              Tested
            </span>
          {/if}
          <span class="hub-row-url">{conn.baseUrl || '(default URL)'}</span>
        </div>
        <div class="hub-row-actions">
          <button class="hub-action" type="button" onclick={() => onEdit(i)}>Edit</button>
          <button class="hub-action" type="button" onclick={() => onDuplicate(i)}>Duplicate</button>
          <button class="hub-action hub-action--danger" type="button" onclick={() => onRemove(i)}>Remove</button>
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .hub-list {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .hub-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .hub-row-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
  }
  .hub-row-name {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
  }
  .hub-row-badge {
    font-size: var(--text-xs);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .hub-row-tested {
    border-color: var(--color-success-border, rgba(64, 192, 87, 0.25));
    background: var(--color-success-bg, rgba(64, 192, 87, 0.1));
    color: var(--color-success);
  }
  .hub-row-url {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
  .hub-row-actions {
    display: flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }
  .hub-action {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    padding: 4px 10px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .hub-action:hover {
    background: var(--color-bg-secondary);
    border-color: var(--color-border-hover);
    color: var(--color-text);
  }
  .hub-action--danger:hover {
    border-color: #fca5a5;
    background: #fef2f2;
    color: #dc2626;
  }
  .hub-empty {
    padding: var(--space-6) var(--space-4);
    text-align: center;
    background: var(--color-bg-secondary);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-lg);
    margin-bottom: var(--space-4);
  }
  .hub-empty-headline {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin: 0 0 var(--space-2);
  }
  .hub-empty-body {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0 0 var(--space-4);
    line-height: 1.5;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 10px 24px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-bold);
    line-height: 1.4;
    border: 1.5px solid transparent;
    border-radius: var(--radius-full);
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
    justify-content: center;
  }
  .btn-primary {
    background: var(--color-primary);
    color: #1a1a1a;
    border-color: transparent;
    box-shadow: 0 1px 3px rgba(255, 157, 0, 0.3), 0 4px 12px rgba(255, 157, 0, 0.2);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }
</style>
