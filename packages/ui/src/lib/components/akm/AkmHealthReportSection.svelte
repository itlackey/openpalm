<script lang="ts">
	import { onMount } from 'svelte';
	type ReportWindow = '24h' | '72h' | '7d' | '14d' | '30d';

	type Props = {
		disabled: boolean;
	};

	let { disabled }: Props = $props();

	const WINDOW_OPTIONS: Array<{ value: ReportWindow; label: string }> = [
		{ value: '24h', label: '24 hours' },
		{ value: '72h', label: '72 hours' },
		{ value: '7d', label: '7 days' },
		{ value: '14d', label: '14 days' },
		{ value: '30d', label: '30 days' },
	];

	let reportWindow = $state<ReportWindow>('72h');
	let refreshKey = $state(0);
	let loading = $state(true);
	let frameLoaded = $state(false);
	let frameSrc = $state<string | null>(null);
	let loadError = $state('');

	let reportUrl = $derived(`/api/host/akm/health-report?since=${encodeURIComponent(reportWindow)}&refresh=${refreshKey}`);

	async function loadReport(): Promise<void> {
		loading = true;
		frameLoaded = false;
		frameSrc = null;
		loadError = '';
		try {
			const res = await fetch(reportUrl, { method: 'HEAD' });
			if (!res.ok) {
				loadError = `Failed to generate report (${res.status} ${res.statusText}).`;
				loading = false;
				return;
			}
		} catch {
			loadError = 'Could not reach the report endpoint. Check that the stack is running.';
			loading = false;
			return;
		}
		frameSrc = reportUrl;
	}

	function refresh(): void {
		refreshKey += 1;
		void loadReport();
	}

	function handleWindowChange(): void {
		refreshKey += 1;
		void loadReport();
	}

	onMount(() => { void loadReport(); });
</script>

<section class="report-section">
	<div class="report-header">
		<div>
			<h3>AKM Health Report</h3>
			<p class="section-note">Build and view a live HTML report from the running assistant's <code>akm health</code> output. The default window is 72 hours.</p>
		</div>
		<div class="report-controls">
			<label class="control-field" for="akm-report-window">
				<span>Time frame</span>
				<select id="akm-report-window" class="control-input" bind:value={reportWindow} onchange={handleWindowChange} {disabled}>
					{#each WINDOW_OPTIONS as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</label>
			<button class="btn btn-secondary btn-sm" type="button" onclick={refresh} {disabled}>Refresh report</button>
		</div>
	</div>

	<div class="report-frame-wrap">
		{#if loadError}
			<div class="report-error" role="alert">
				<p>{loadError}</p>
				<button class="btn btn-secondary btn-sm" type="button" onclick={refresh}>Retry</button>
			</div>
		{:else}
			{#if loading || !frameLoaded}
				<div class="report-loading">Generating report…</div>
			{/if}
			{#if frameSrc}
				<iframe
					title="AKM Health Report"
					class="report-frame"
					src={frameSrc}
					onload={() => { loading = false; frameLoaded = true; }}
				></iframe>
			{/if}
		{/if}
	</div>
</section>

<style>
	.report-section {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-4);
	}

	.report-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: var(--s-sp-4);
		flex-wrap: wrap;
	}

	.report-header h3 {
		margin: 0 0 var(--s-sp-2);
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		font-weight: 400;
		color: var(--s-ink);
	}

	.report-controls {
		display: flex;
		align-items: end;
		gap: var(--s-sp-3);
		flex-wrap: wrap;
	}

	.control-field {
		display: grid;
		gap: var(--s-sp-1);
		min-width: 11rem;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	.control-input {
		border: 0;
		border-bottom: var(--s-hair) solid var(--s-line);
		background: none;
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink);
		padding: 0.5rem 0;
		width: 100%;
	}

	.control-input:focus { outline: none; border-bottom-color: var(--s-ink-2); }

	.report-frame-wrap {
		position: relative;
		min-height: 70dvh;
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
		overflow: hidden;
		background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
	}

	.report-loading {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-3);
		background: color-mix(in srgb, var(--s-paper) 88%, transparent);
		z-index: 1;
	}

	.report-frame {
		display: block;
		width: 100%;
		min-height: 70dvh;
		border: 0;
		background: var(--s-paper-deep);
	}

	.report-error {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--s-sp-3);
		padding: var(--s-sp-6);
		color: var(--s-seal);
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		min-height: 30dvh;
		text-align: center;
	}

	.report-error p { margin: 0; }

	@media (max-width: 640px) {
		.report-controls { width: 100%; }
		.control-field { min-width: min(100%, 11rem); }
		.report-frame-wrap, .report-frame { min-height: 62dvh; }
	}
</style>
