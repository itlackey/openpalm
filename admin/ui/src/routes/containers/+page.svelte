<script lang="ts">
	import { apiGet, apiPost } from '$lib/api';
	import { showToast } from '$lib/stores/toast';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';

	type ContainerStatus = {
		name: string;
		state: string;
		status: string;
		[key: string]: unknown;
	};

	type ContainerListResponse = ContainerStatus[] | Record<string, ContainerStatus>;

	type ContainerActionResponse = {
		ok: boolean;
		action: string;
		service: string;
	};

	const ALLOWED_SERVICES = [
		'opencode-core',
		'gateway',
		'openmemory',
		'admin',
		'channel-chat',
		'channel-discord',
		'channel-voice',
		'channel-telegram',
		'caddy'
	] as const;

	type ServiceName = (typeof ALLOWED_SERVICES)[number];

	const SERVICE_LABELS: Record<ServiceName, string> = {
		'opencode-core': 'OpenCode Core',
		'gateway': 'Gateway',
		'openmemory': 'OpenMemory',
		'admin': 'Admin',
		'channel-chat': 'Chat Channel',
		'channel-discord': 'Discord Channel',
		'channel-voice': 'Voice Channel',
		'channel-telegram': 'Telegram Channel',
		'caddy': 'Caddy'
	};

	const SERVICE_DESCRIPTIONS: Record<ServiceName, string> = {
		'opencode-core': 'Core AI engine and orchestration service',
		'gateway': 'API gateway and request routing',
		'openmemory': 'Long-term memory and knowledge storage',
		'admin': 'Administration panel and management API',
		'channel-chat': 'Web-based chat interface',
		'channel-discord': 'Discord bot integration',
		'channel-voice': 'Voice communication channel',
		'channel-telegram': 'Telegram bot integration',
		'caddy': 'Reverse proxy and TLS termination'
	};

	let loading = $state(true);
	let refreshing = $state(false);
	let containers = $state<ContainerStatus[]>([]);
	let busyServices = $state<Set<string>>(new Set());
	let behindCaddy = $state(false);

	$effect(() => {
		if (typeof window !== 'undefined') {
			behindCaddy = window.location.pathname.startsWith('/admin');
		}
		loadContainers();
	});

	async function loadContainers() {
		loading = true;
		const res = await apiGet<ContainerListResponse>('/admin/containers/list');
		if (res.ok && res.data) {
			if (Array.isArray(res.data)) {
				containers = res.data;
			} else if (typeof res.data === 'object') {
				containers = Object.values(res.data);
			}
		} else {
			showToast('Failed to fetch container list', 'error');
			containers = [];
		}
		loading = false;
	}

	async function refreshContainers() {
		refreshing = true;
		const res = await apiGet<ContainerListResponse>('/admin/containers/list');
		if (res.ok && res.data) {
			if (Array.isArray(res.data)) {
				containers = res.data;
			} else if (typeof res.data === 'object') {
				containers = Object.values(res.data);
			}
			showToast('Container list refreshed', 'success');
		} else {
			showToast('Failed to refresh container list', 'error');
		}
		refreshing = false;
	}

	function getContainerForService(service: ServiceName): ContainerStatus | undefined {
		return containers.find((c) => {
			const name = (c.name || '').toLowerCase().replace(/^\//, '');
			return name.includes(service);
		});
	}

	function getServiceStatus(service: ServiceName): { label: string; state: 'running' | 'stopped' | 'unknown' } {
		const container = getContainerForService(service);
		if (!container) {
			return { label: 'Not found', state: 'stopped' };
		}
		const state = (container.state || '').toLowerCase();
		if (state === 'running') {
			return { label: container.status || 'Running', state: 'running' };
		}
		if (state === 'exited' || state === 'dead' || state === 'created') {
			return { label: container.status || state.charAt(0).toUpperCase() + state.slice(1), state: 'stopped' };
		}
		return { label: container.status || state || 'Unknown', state: 'unknown' };
	}

	function isServiceBusy(service: ServiceName): boolean {
		return busyServices.has(service);
	}

	async function performAction(service: ServiceName, action: 'up' | 'down' | 'restart') {
		const actionLabels = { up: 'Starting', down: 'Stopping', restart: 'Restarting' };
		const successLabels = { up: 'started', down: 'stopped', restart: 'restarted' };

		busyServices = new Set([...busyServices, service]);

		try {
			const res = await apiPost<ContainerActionResponse>(
				`/admin/containers/${action}`,
				{ service }
			);

			if (res.ok) {
				showToast(`${SERVICE_LABELS[service]} ${successLabels[action]} successfully`, 'success');
				// Refresh the container list after action
				const listRes = await apiGet<ContainerListResponse>('/admin/containers/list');
				if (listRes.ok && listRes.data) {
					if (Array.isArray(listRes.data)) {
						containers = listRes.data;
					} else if (typeof listRes.data === 'object') {
						containers = Object.values(listRes.data);
					}
				}
			} else {
				const errData = res.data as unknown as { error?: string };
				const errMsg = errData?.error || `Failed to ${action} ${SERVICE_LABELS[service]}`;
				showToast(errMsg, 'error');
			}
		} catch {
			showToast(`Error ${actionLabels[action].toLowerCase()} ${SERVICE_LABELS[service]}`, 'error');
		} finally {
			const next = new Set(busyServices);
			next.delete(service);
			busyServices = next;
		}
	}

	function buildEmbeddedUrl(path: string): string {
		if (typeof window === 'undefined') return path;
		return `${window.location.origin}${path}`;
	}

	let runningCount = $derived(
		ALLOWED_SERVICES.filter((s) => getServiceStatus(s).state === 'running').length
	);
</script>

<svelte:head>
	<title>Container Management - OpenPalm Admin</title>
</svelte:head>

<div class="container">
	<header class="page-header">
		<div>
			<h1>Container Management</h1>
			<p class="muted">Start, stop, and restart individual services.</p>
		</div>
	</header>

	<!-- Container List -->
	<section class="section" aria-labelledby="containers-heading">
		<div class="section-header">
			<h2 id="containers-heading">Services</h2>
			<button
				class="btn-secondary btn-sm"
				onclick={refreshContainers}
				disabled={refreshing || loading}
				aria-label="Refresh container list"
			>
				{#if refreshing}
					Refreshing...
				{:else}
					Refresh
				{/if}
			</button>
		</div>

		{#if !loading}
			<p class="status-summary muted">
				{runningCount} of {ALLOWED_SERVICES.length} services running
			</p>
		{/if}

		{#if loading}
			<LoadingSpinner message="Loading containers..." />
		{:else}
			<div class="service-grid" role="list" aria-label="Service cards">
				{#each ALLOWED_SERVICES as service (service)}
					{@const status = getServiceStatus(service)}
					{@const busy = isServiceBusy(service)}
					<div
						class="card service-card"
						class:running={status.state === 'running'}
						class:stopped={status.state === 'stopped'}
						role="listitem"
					>
						<div class="card-top">
							<span
								class="status-dot"
								class:dot-running={status.state === 'running'}
								class:dot-stopped={status.state === 'stopped'}
								class:dot-unknown={status.state === 'unknown'}
								aria-hidden="true"
							></span>
							<span class="service-name">{SERVICE_LABELS[service]}</span>
						</div>

						<p class="service-desc">{SERVICE_DESCRIPTIONS[service]}</p>

						<div class="card-meta">
							{#if status.state === 'running'}
								<span class="status-text ok">{status.label}</span>
							{:else if status.state === 'stopped'}
								<span class="status-text err">{status.label}</span>
							{:else}
								<span class="status-text unknown">{status.label}</span>
							{/if}
						</div>

						<div class="card-actions">
							<button
								class="btn-sm btn-start"
								onclick={() => performAction(service, 'up')}
								disabled={busy}
								aria-label="Start {SERVICE_LABELS[service]}"
							>
								{#if busy && busyServices.has(service)}
									<LoadingSpinner size={14} />
								{/if}
								Start
							</button>
							<button
								class="btn-sm btn-stop"
								onclick={() => performAction(service, 'down')}
								disabled={busy}
								aria-label="Stop {SERVICE_LABELS[service]}"
							>
								Stop
							</button>
							<button
								class="btn-sm btn-restart"
								onclick={() => performAction(service, 'restart')}
								disabled={busy}
								aria-label="Restart {SERVICE_LABELS[service]}"
							>
								Restart
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Embedded UIs (only behind Caddy) -->
	{#if behindCaddy}
		<section class="section" aria-labelledby="embedded-heading">
			<h2 id="embedded-heading">Embedded UIs</h2>
			<p class="muted mb">Access companion services directly from the admin panel.</p>

			<div class="embedded-cards">
				<div class="card embedded-card">
					<h3>OpenCode UI</h3>
					<iframe
						src={buildEmbeddedUrl('/admin/opencode/')}
						title="OpenCode UI"
						class="embedded-iframe"
						loading="lazy"
						sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
					></iframe>
				</div>

				<div class="card embedded-card">
					<h3>OpenMemory UI</h3>
					<iframe
						src={buildEmbeddedUrl('/admin/openmemory/')}
						title="OpenMemory UI"
						class="embedded-iframe"
						loading="lazy"
						sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
					></iframe>
				</div>
			</div>
		</section>
	{/if}
</div>

<style>
	.page-header {
		margin-bottom: 1.5rem;
	}
	.page-header h1 {
		margin: 0 0 0.25rem;
		font-size: 1.6rem;
	}
	.page-header p {
		margin: 0;
	}

	.section {
		margin-bottom: 2rem;
	}
	.section h2 {
		font-size: 1.15rem;
		margin: 0 0 0.4rem;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
	}
	.section-header h2 {
		margin: 0;
	}

	.status-summary {
		margin: 0 0 0.75rem;
		font-size: 13px;
	}

	/* Service grid */
	.service-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
		margin-top: 0.5rem;
	}

	@media (max-width: 900px) {
		.service-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (max-width: 600px) {
		.service-grid {
			grid-template-columns: 1fr;
		}
	}

	/* Service cards */
	.service-card {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		transition: border-color 0.2s;
	}
	.service-card.running {
		border-color: color-mix(in srgb, var(--green) 30%, var(--border));
	}
	.service-card.stopped {
		border-color: color-mix(in srgb, var(--red) 25%, var(--border));
	}

	.card-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.dot-running {
		background: var(--green);
		box-shadow: 0 0 6px color-mix(in srgb, var(--green) 50%, transparent);
	}
	.dot-stopped {
		background: var(--red);
	}
	.dot-unknown {
		background: var(--muted);
	}

	.service-name {
		font-weight: 600;
		font-size: 15px;
	}

	.service-desc {
		margin: 0;
		font-size: 12px;
		color: var(--muted);
		line-height: 1.4;
	}

	.card-meta {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 13px;
		margin-top: 0.1rem;
	}

	.status-text {
		font-weight: 500;
	}
	.status-text.ok {
		color: var(--green);
	}
	.status-text.err {
		color: var(--red);
	}
	.status-text.unknown {
		color: var(--muted);
	}

	/* Action buttons */
	.card-actions {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.4rem;
		flex-wrap: wrap;
	}

	.btn-start {
		background: var(--green);
		color: #fff;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	.btn-stop {
		background: var(--red);
		color: #fff;
	}

	.btn-restart {
		background: var(--accent);
		color: #fff;
	}

	/* Embedded UIs */
	.embedded-cards {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.embedded-card {
		padding: 1rem;
	}
	.embedded-card h3 {
		margin: 0 0 0.75rem;
		font-size: 15px;
		font-weight: 600;
	}

	.embedded-iframe {
		width: 100%;
		height: 600px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
	}
</style>
