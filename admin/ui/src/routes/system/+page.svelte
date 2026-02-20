<script lang="ts">
	import { apiGet } from '$lib/api';
	import { showToast } from '$lib/stores/toast';
	import { setToken } from '$lib/stores/auth';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import HealthBadge from '$lib/components/HealthBadge.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import type { HealthResult } from '$lib/types';

	type HealthCheckResponse = {
		services: Record<string, HealthResult>;
	};

	type MetaResponse = {
		serviceNames: Record<string, { label: string; description: string }>;
	};

	let loading = $state(true);
	let services = $state<Record<string, HealthResult>>({});
	let serviceNames = $state<Record<string, { label: string; description: string }>>({});
	let refreshing = $state(false);

	let password = $state('');
	let saving = $state(false);

	$effect(() => {
		loadData();
	});

	async function loadData() {
		loading = true;
		const [healthRes, metaRes] = await Promise.all([
			apiGet<HealthCheckResponse>('/admin/setup/health-check', { noAuth: true }),
			apiGet<MetaResponse>('/admin/meta', { noAuth: true })
		]);

		if (healthRes.ok && healthRes.data?.services) {
			services = healthRes.data.services;
		} else {
			showToast('Failed to fetch service health', 'error');
		}

		if (metaRes.ok && metaRes.data?.serviceNames) {
			serviceNames = metaRes.data.serviceNames;
		}

		loading = false;
	}

	async function refreshHealth() {
		refreshing = true;
		const res = await apiGet<HealthCheckResponse>('/admin/setup/health-check', { noAuth: true });
		if (res.ok && res.data?.services) {
			services = res.data.services;
			showToast('Health status refreshed', 'success');
		} else {
			showToast('Failed to refresh health status', 'error');
		}
		refreshing = false;
	}

	function getServiceLabel(key: string): string {
		if (serviceNames[key]?.label) return serviceNames[key].label;
		return key.charAt(0).toUpperCase() + key.slice(1);
	}

	function getServiceDescription(key: string): string {
		return serviceNames[key]?.description ?? '';
	}

	function formatTime(time?: string): string {
		if (!time) return '';
		// If it looks like an ISO timestamp, format it as a locale time string
		if (time.includes('T') || time.includes('-')) {
			try {
				const d = new Date(time);
				if (!isNaN(d.getTime())) return d.toLocaleTimeString();
			} catch { /* fall through */ }
		}
		// Pure numeric string = milliseconds
		const ms = parseInt(time, 10);
		if (!isNaN(ms) && String(ms) === time.trim()) return `${ms}ms`;
		return time;
	}

	let serviceKeys = $derived(Object.keys(services));

	let healthyCount = $derived(
		serviceKeys.filter((k) => services[k]?.ok === true).length
	);

	let totalCount = $derived(serviceKeys.length);

	async function savePassword() {
		if (!password.trim()) {
			showToast('Please enter a password', 'error');
			return;
		}

		saving = true;
		setToken(password.trim());

		const res = await apiGet('/admin/installed');
		if (res.ok) {
			showToast('Admin password saved and validated', 'success');
			password = '';
		} else {
			showToast('Password validation failed. The token may be incorrect.', 'error');
		}
		saving = false;
	}

	function goToSetup() {
		goto(`${base}/setup`);
	}
</script>

<svelte:head>
	<title>System Status - OpenPalm Admin</title>
</svelte:head>

<div class="container">
	<header class="page-header">
		<div>
			<h1>System Status</h1>
			<p class="muted">Monitor service health, manage credentials, and access system tools.</p>
		</div>
	</header>

	<!-- Service Health Status -->
	<section class="section" aria-labelledby="health-heading">
		<div class="section-header">
			<h2 id="health-heading">Service Health</h2>
			<button
				class="btn-secondary btn-sm"
				onclick={refreshHealth}
				disabled={refreshing || loading}
				aria-label="Refresh health status"
			>
				{#if refreshing}
					Refreshing...
				{:else}
					Refresh
				{/if}
			</button>
		</div>

		{#if !loading && totalCount > 0}
			<p class="health-summary muted">
				{healthyCount} of {totalCount} services healthy
			</p>
		{/if}

		{#if loading}
			<LoadingSpinner message="Checking service health..." />
		{:else if serviceKeys.length === 0}
			<div class="empty-state">
				<p>No service health data available.</p>
			</div>
		{:else}
			<div class="grid3 health-grid" role="list" aria-label="Service health cards">
				{#each serviceKeys as key (key)}
					{@const svc = services[key]}
					<div
						class="card health-card"
						class:healthy={svc.ok === true}
						class:unhealthy={svc.ok === false}
						role="listitem"
					>
						<div class="card-top">
							<HealthBadge ok={svc.ok} />
							<span class="service-name">{getServiceLabel(key)}</span>
						</div>
						{#if getServiceDescription(key)}
							<p class="service-desc">{getServiceDescription(key)}</p>
						{/if}
						<div class="card-meta">
							{#if svc.ok === true}
								<span class="status-text ok">Healthy</span>
							{:else if svc.ok === false}
								<span class="status-text err">Error</span>
							{:else}
								<span class="status-text unknown">Unknown</span>
							{/if}
							{#if svc.time}
								<span class="response-time" title="Response time">
									{formatTime(svc.time)}
								</span>
							{/if}
						</div>
						{#if svc.error}
							<p class="error-detail" role="alert">{svc.error}</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Admin Password -->
	<section class="section" aria-labelledby="password-heading">
		<h2 id="password-heading">Admin Password</h2>
		<p class="muted mb">Update the stored admin authentication token used for API requests.</p>
		<div class="password-form">
			<div class="form-group">
				<label for="admin-password">Admin Token</label>
				<input
					id="admin-password"
					type="password"
					bind:value={password}
					placeholder="Enter admin password"
					autocomplete="current-password"
					onkeydown={(e) => { if (e.key === 'Enter') savePassword(); }}
				/>
				<p class="help-text">This token is stored locally and sent with authenticated API requests.</p>
			</div>
			<button onclick={savePassword} disabled={saving || !password.trim()}>
				{#if saving}
					Validating...
				{:else}
					Save & Validate
				{/if}
			</button>
		</div>
	</section>

	<!-- Re-run Setup Wizard -->
	<section class="section" aria-labelledby="setup-heading">
		<h2 id="setup-heading">Setup Wizard</h2>
		<p class="muted mb">Re-run the initial setup wizard to reconfigure services, channels, and extensions.</p>
		<button class="btn-secondary" onclick={goToSetup}>
			Re-run Setup Wizard
		</button>
	</section>

	<!-- Quick Actions -->
	<section class="section" aria-labelledby="actions-heading">
		<h2 id="actions-heading">Quick Actions</h2>
		<p class="muted mb">Jump to other management pages.</p>
		<div class="grid3 actions-grid">
			<a href="{base}/providers" class="card action-card">
				<h3>Providers</h3>
				<p class="muted">Manage LLM provider connections and API keys.</p>
			</a>
			<a href="{base}/config" class="card action-card">
				<h3>Config Editor</h3>
				<p class="muted">View and edit the raw system configuration.</p>
			</a>
			<a href="{base}/containers" class="card action-card">
				<h3>Containers</h3>
				<p class="muted">Manage Docker containers and service instances.</p>
			</a>
		</div>
	</section>
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

	.health-summary {
		margin: 0 0 0.75rem;
		font-size: 13px;
	}

	/* Health cards */
	.health-grid {
		margin-top: 0.5rem;
	}

	.health-card {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		transition: border-color 0.2s;
	}
	.health-card.healthy {
		border-color: color-mix(in srgb, var(--green) 30%, var(--border));
	}
	.health-card.unhealthy {
		border-color: color-mix(in srgb, var(--red) 40%, var(--border));
	}

	.card-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
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
		margin-top: 0.2rem;
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

	.response-time {
		color: var(--muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	.error-detail {
		margin: 0.25rem 0 0;
		padding: 0.4rem 0.6rem;
		background: color-mix(in srgb, var(--red) 10%, var(--surface));
		border-radius: calc(var(--radius) / 2);
		font-size: 12px;
		color: var(--red);
		line-height: 1.4;
		word-break: break-word;
	}

	/* Password form */
	.password-form {
		max-width: 420px;
	}
	.password-form button {
		margin-top: 0.5rem;
	}

	/* Quick actions */
	.action-card {
		text-decoration: none;
		color: var(--text);
		transition: border-color 0.2s, background 0.2s;
		cursor: pointer;
	}
	.action-card:hover {
		border-color: var(--accent);
		background: var(--surface2);
		text-decoration: none;
	}
	.action-card h3 {
		margin: 0 0 0.3rem;
		font-size: 15px;
	}
	.action-card p {
		margin: 0;
		font-size: 13px;
	}
</style>
