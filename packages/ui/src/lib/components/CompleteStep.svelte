<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	const SERVICE_NAMES: Record<string, string> = {
		gateway: 'Message Router',
		assistant: 'AI Assistant',
		openmemory: 'Memory',
		admin: 'Admin Panel',
		caddy: 'Reverse Proxy',
		'openmemory-ui': 'Memory UI',
		postgres: 'Database',
		qdrant: 'Vector DB'
	};

	const PHASE_LABELS: Record<string, string> = {
		idle: 'Waiting...',
		applying: 'Applying configuration...',
		starting: 'Starting services...',
		checking: 'Checking service readiness...',
		ready: 'Everything is ready!',
		failed: 'Some services need attention.'
	};

	interface ServiceCheck {
		service: string;
		state: 'ready' | 'not_ready';
		status: string;
		health?: string | null;
		reason?: string;
		probeUrl?: string;
		probeError?: string;
	}

	interface ReadinessSnapshot {
		phase: string;
		updatedAt: string;
		checks: ServiceCheck[];
		diagnostics: {
			composePsStderr?: string;
			failedServices: ServiceCheck[];
			failedServiceLogs?: Record<string, string>;
		};
	}

	interface Props {
		oncontinue: () => void;
		initialReadiness?: ReadinessSnapshot | null;
	}

	let { oncontinue, initialReadiness = null }: Props = $props();

	let phase = $state('checking');
	let checks = $state<ServiceCheck[]>([]);
	let diagnostics = $state<ReadinessSnapshot['diagnostics']>({ failedServices: [] });
	let retrying = $state(false);
	let showDiagnostics = $state(false);
	let pollCount = $state(0);

	const phaseLabel = $derived(PHASE_LABELS[phase] ?? phase);
	const isReady = $derived(phase === 'ready');
	const isFailed = $derived(phase === 'failed');
	const isInProgress = $derived(phase === 'applying' || phase === 'starting' || phase === 'checking');

	function friendlyName(service: string): string {
		return SERVICE_NAMES[service] ?? service;
	}

	function reasonLabel(check: ServiceCheck): string {
		if (check.state === 'ready') return 'ready';
		if (check.reason === 'missing') return 'not found';
		if (check.reason === 'not_running') return `stopped (${check.status})`;
		if (check.reason === 'unhealthy') return `unhealthy (${check.health ?? 'unknown'})`;
		if (check.reason === 'http_probe_failed') {
			return check.probeError ? `probe failed: ${check.probeError}` : 'probe failed';
		}
		return check.status || 'unknown';
	}

	function applySnapshot(snapshot: ReadinessSnapshot) {
		phase = snapshot.phase;
		checks = snapshot.checks ?? [];
		diagnostics = snapshot.diagnostics ?? { failedServices: [] };
	}

	async function pollReadiness() {
		const MAX_POLLS = 30;
		const POLL_INTERVAL_MS = 2000;

		for (let i = 0; i < MAX_POLLS; i++) {
			pollCount = i + 1;
			const r = await api('/setup/core-readiness');
			if (r.ok && r.data) {
				if (r.data.phase === 'ready' || r.data.phase === 'failed') {
					applySnapshot(r.data as ReadinessSnapshot);
					return;
				}
				// Update in-progress state
				if (r.data.phase) {
					phase = r.data.phase;
				}
				if (r.data.checks) {
					checks = r.data.checks;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
		// If we exhausted polls and never got ready/failed, mark as failed
		if (!isReady) {
			phase = 'failed';
		}
	}

	async function retryReadiness() {
		if (retrying) return;
		retrying = true;
		showDiagnostics = false;
		phase = 'checking';
		checks = [];
		diagnostics = { failedServices: [] };

		try {
			const r = await api('/setup/core-readiness/retry', { method: 'POST' });
			if (r.ok && r.data) {
				applySnapshot(r.data as ReadinessSnapshot);
			} else {
				phase = 'failed';
			}
		} catch {
			phase = 'failed';
		} finally {
			retrying = false;
		}
	}

	onMount(() => {
		if (initialReadiness && initialReadiness.phase) {
			applySnapshot(initialReadiness);
			// If the initial snapshot shows in-progress, poll for updates
			if (initialReadiness.phase !== 'ready' && initialReadiness.phase !== 'failed') {
				pollReadiness();
			}
		} else {
			// No initial data — poll the backend for current readiness state
			pollReadiness();
		}
	});
</script>

<p>Finalizing setup and starting your assistant...</p>

<div>
	<p class="muted">{phaseLabel}{#if isInProgress && pollCount > 1} ({pollCount}){/if}</p>

	{#if checks.length > 0}
		<ul class="readiness-checks" style="margin:0.4rem 0; padding-left:1.2rem; font-size:13px; list-style:none">
			{#each checks as check}
				<li style="margin:0.2rem 0; color: {check.state === 'ready' ? 'var(--green, green)' : isInProgress ? 'var(--muted, #888)' : 'var(--red, red)'}">
					<span aria-hidden="true">{check.state === 'ready' ? '\u2713' : isInProgress ? '\u25CB' : '\u2717'}</span>
					<span class="sr-only">{check.state === 'ready' ? 'Ready' : 'Not ready'}</span>
					<strong>{friendlyName(check.service)}</strong>
					&mdash; {check.state === 'ready' ? 'ready' : isInProgress ? 'starting...' : reasonLabel(check)}
				</li>
			{/each}
		</ul>
	{/if}

	{#if isReady}
		<p style="margin:0.5rem 0; color: var(--green, green); font-weight:600">
			All services are running and healthy.
		</p>
		<button onclick={oncontinue}>Continue to Admin</button>
	{:else if isFailed}
		<div style="margin:0.5rem 0">
			<p>Some services need attention:</p>
			<ul style="margin:0.4rem 0; padding-left:1.2rem; font-size:13px">
				{#each diagnostics.failedServices as check}
					<li style="color: var(--red, red)">
						<strong>{friendlyName(check.service)}</strong> &mdash; {reasonLabel(check)}
						{#if check.probeUrl}
							<span class="muted" style="font-size:12px"> ({check.probeUrl})</span>
						{/if}
					</li>
				{/each}
			</ul>

			{#if diagnostics.failedServiceLogs && Object.keys(diagnostics.failedServiceLogs).length > 0}
				<button
					class="btn-link"
					style="font-size:12px; margin:0.3rem 0; cursor:pointer; background:none; border:none; color:var(--link, #0366d6); text-decoration:underline; padding:0"
					onclick={() => (showDiagnostics = !showDiagnostics)}
				>
					{showDiagnostics ? 'Hide' : 'Show'} diagnostics
				</button>

				{#if showDiagnostics}
					<div class="diagnostics-panel" style="margin:0.5rem 0; padding:0.5rem; background:var(--bg-muted, #f6f8fa); border-radius:4px; font-size:12px; max-height:200px; overflow:auto">
						{#if diagnostics.composePsStderr}
							<div style="margin-bottom:0.4rem">
								<strong>Compose stderr:</strong>
								<pre style="white-space:pre-wrap; margin:0.2rem 0; font-size:11px">{diagnostics.composePsStderr}</pre>
							</div>
						{/if}
						{#each Object.entries(diagnostics.failedServiceLogs) as [service, logs]}
							<div style="margin-bottom:0.4rem">
								<strong>{friendlyName(service)} logs:</strong>
								<pre style="white-space:pre-wrap; margin:0.2rem 0; font-size:11px; max-height:100px; overflow:auto">{logs}</pre>
							</div>
						{/each}
					</div>
				{/if}
			{/if}

			<p class="muted" style="font-size:13px; margin:0.4rem 0">
				Check your API keys and Docker status, then retry or run <code>openpalm logs</code> for details.
			</p>

			<div style="display:flex; gap:0.5rem; margin-top:0.5rem">
				<button onclick={retryReadiness} disabled={retrying}>
					{retrying ? 'Retrying...' : 'Retry Readiness Check'}
				</button>
				<button class="btn-secondary" onclick={oncontinue}>Continue to Admin</button>
			</div>
		</div>
	{/if}
</div>
