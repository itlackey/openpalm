<script lang="ts">
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

	let reportUrl = $derived(`/admin/akm/health-report?since=${encodeURIComponent(reportWindow)}&refresh=${refreshKey}`);

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
	}

	function handleWindowChange(): void {
		refreshKey += 1;
	}

	$effect(() => {
		// Re-run the preflight whenever reportUrl changes (window or refreshKey).
		void loadReport();
	});
</script>

<section class="report-section">
	<div class="report-header">
		<div>
			<h3>AKM Health Report</h3>
			<p class="section-note">Build and view a live HTML report from the current stack's <code>akm health</code> output. The default window is 72 hours.</p>
		</div>
		<div class="report-controls">
			<label class="control-field" for="akm-report-window">
				<span>Time frame</span>
				<select id="akm-report-window" class="control-input" bind:value={reportWindow} onchange={handleWindowChange} {disabled}>
					{#each WINDOW_OPTIONS as option}
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
		gap: var(--space-4);
	}

	.report-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: var(--space-4);
		flex-wrap: wrap;
	}

	.report-header h3 {
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
		font-weight: var(--font-semibold);
		color: var(--color-text);
	}

	.report-controls {
		display: flex;
		align-items: end;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.control-field {
		display: grid;
		gap: var(--space-1);
		min-width: 11rem;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.control-input {
		font-size: var(--text-sm);
		color: var(--color-text);
		background: var(--color-input-bg, var(--color-bg));
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: var(--space-2) var(--space-3);
		width: 100%;
	}

	.control-input:focus {
		outline: 2px solid var(--color-primary);
		outline-offset: 1px;
	}

	.report-frame-wrap {
		position: relative;
		min-height: 70dvh;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--color-bg-secondary);
	}

	.report-loading {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
		background: color-mix(in srgb, var(--color-bg-secondary) 88%, transparent);
		z-index: 1;
	}

	.report-frame {
		display: block;
		width: 100%;
		min-height: 70dvh;
		border: 0;
		background: var(--color-bg-tertiary);
	}

	.report-error {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-3);
		padding: var(--space-6);
		color: var(--color-danger);
		font-size: var(--text-sm);
		min-height: 30dvh;
		text-align: center;
	}

	.report-error p {
		margin: 0;
	}

	@media (max-width: 640px) {
		.report-controls {
			width: 100%;
		}

		.control-field {
			min-width: min(100%, 11rem);
		}

		.report-frame-wrap,
		.report-frame {
			min-height: 62dvh;
		}
	}
</style>
