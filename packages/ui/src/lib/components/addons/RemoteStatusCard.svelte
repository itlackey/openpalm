<!--
  RemoteStatusCard — observed state of the remote addon's selected provider,
  rendered from the normalized RemoteAccessStatus vocabulary (roadmap:
  remote-access-providers.md §4/§5). Provider-agnostic on purpose: a state
  chip, one sentence, at most one action button, copyable facts, named
  progress stages. A later provider maps into the same vocabulary and this
  component never changes.

  Self-contained: fetches on mount and re-polls while mounted, because
  states clear by OBSERVATION (a sign-in completing, a tunnel coming up),
  never by the operator clicking "done".

  Used by the Capabilities (Add-ons) remote drawer.
-->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { fetchRemoteAccessStatus, type RemoteAccessStatus } from '$lib/api.js';

	const POLL_MS = 5000;

	let status = $state<RemoteAccessStatus | null>(null);
	let loadError = $state('');
	let copiedValue = $state('');
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	const STATE_LABELS: Record<RemoteAccessStatus['state'], string> = {
		off: 'Off',
		'awaiting-config': 'Needs setup',
		'awaiting-authentication': 'Sign in to finish',
		'pending-external': 'Waiting',
		starting: 'Starting',
		up: 'Up',
		degraded: 'Degraded',
		error: 'Error',
	};

	async function refresh(): Promise<void> {
		try {
			status = await fetchRemoteAccessStatus();
			loadError = '';
		} catch (err) {
			// Keep the last observed status on a transient fetch failure; the
			// error line says the OBSERVATION failed, which is not the same
			// claim as the tunnel being down.
			loadError = err instanceof Error ? err.message : 'Could not read remote access status.';
		}
		pollTimer = setTimeout(() => void refresh(), POLL_MS);
	}

	async function copyValue(value: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			copiedValue = value;
			setTimeout(() => { if (copiedValue === value) copiedValue = ''; }, 2000);
		} catch {
			// Clipboard access can be denied (permissions, insecure context);
			// the value is still selectable text, so this is a silent no-op.
		}
	}

	onMount(() => { void refresh(); });
	onDestroy(() => { if (pollTimer) clearTimeout(pollTimer); });
</script>

<section class="remote-status" aria-live="polite">
	{#if !status}
		<p class="status-line">Checking remote access…</p>
	{:else}
		<p class="status-line">
			<span class="status-chip status-{status.state}">{STATE_LABELS[status.state]}</span>
			{status.message}
		</p>

		{#if status.action}
			<a class="status-action" href={status.action.url} target="_blank" rel="noopener noreferrer">
				{status.action.label}
			</a>
		{/if}

		{#if status.progress && status.progress.length > 0}
			<ul class="status-progress">
				{#each status.progress as stage (stage.stage)}
					<li class:done={stage.done}>{stage.stage}</li>
				{/each}
			</ul>
		{/if}

		{#if status.copyables && status.copyables.length > 0}
			<ul class="status-copyables">
				{#each status.copyables as item (item.label)}
					<li class="copyable-row">
						<span class="copyable-label">{item.label}</span>
						<code class="copyable-value">{item.value}</code>
						<button type="button" class="copy-btn" onclick={() => void copyValue(item.value)}>
							{copiedValue === item.value ? 'Copied' : 'Copy'}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	{#if loadError}
		<p class="status-error">{loadError}</p>
	{/if}
</section>

<style>
	.remote-status {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.status-line {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-1);
		margin: 0;
	}
	.status-chip {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		margin-right: 0.4rem;
		border: 1px solid var(--s-line);
		border-radius: 999px;
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-2);
	}
	.status-up { color: var(--s-ok, var(--s-ink-1)); }
	.status-error, .status-degraded { color: var(--s-danger, var(--s-ink-1)); }
	.status-action {
		align-self: flex-start;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
	}
	.status-progress {
		list-style: none;
		margin: 0;
		padding: 0;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-2);
	}
	.status-progress li.done::before { content: '✓ '; }
	.status-progress li:not(.done)::before { content: '· '; }
	.status-copyables {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.copyable-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.copyable-label {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-2);
	}
	.copyable-value {
		font-size: var(--s-type-mark-sm);
		overflow-wrap: anywhere;
	}
	.status-error {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-danger, var(--s-ink-2));
		margin: 0;
	}
</style>
