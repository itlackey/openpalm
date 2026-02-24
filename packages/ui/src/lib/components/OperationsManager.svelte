<script lang="ts">
	import { api } from '$lib/api';
	import { showToast } from '$lib/stores/toast.svelte';
	import { getAdminToken } from '$lib/stores/auth.svelte';

	type Automation = {
		id: string;
		name: string;
		schedule: string;
		script: string;
		enabled: boolean;
		core?: boolean;
		lastRun?: { ts: string; status: string; preview?: string } | null;
	};

	type ContainerService = {
		name: string;
		status: string;
		image: string;
		updateAvailable: boolean;
	};

	let services = $state<ContainerService[]>([]);
	let automations = $state<Automation[]>([]);
	let selectedService = $state('');
	let serviceLogs = $state('');
	let selectedAutomation = $state('');
	let automationLogs = $state('');
	let newName = $state('');
	let newSchedule = $state('*/15 * * * *');
	let newScript = $state('echo "hello from openpalm automation"');
	let busy = $state(false);

	const hasToken = $derived(getAdminToken().length > 0);

	async function loadServices() {
		if (!hasToken) return;
		const r = await api('/containers');
		if (!r.ok) return;
		services = r.data?.services ?? [];
	}

	async function loadAutomations() {
		if (!hasToken) return;
		const r = await api('/automations');
		if (!r.ok) return;
		automations = r.data?.automations ?? [];
	}

	async function serviceAction(action: 'up' | 'stop' | 'restart' | 'update', service: string) {
		busy = true;
		const r = await api(`/containers/${action}`, {
			method: 'POST',
			body: JSON.stringify({ service })
		});
		busy = false;
		if (r.ok) {
			showToast(`Service ${service}: ${action} complete`, 'success');
			return;
		}
		showToast(`Service ${service}: ${r.data?.error || 'action failed'}`, 'error');
	}

	async function loadServiceLogs(service: string) {
		selectedService = service;
		const r = await api('/containers/service-logs', {
			method: 'POST',
			body: JSON.stringify({ service, tail: 200 })
		});
		if (!r.ok) {
			serviceLogs = `Failed to load logs: ${r.data?.error || 'unknown error'}`;
			showToast(`Service ${service}: logs failed`, 'error');
			return;
		}
		serviceLogs = r.data?.logs ?? '';
	}

	async function addAutomation() {
		busy = true;
		const r = await api('/automations', {
			method: 'POST',
			body: JSON.stringify({
				name: newName,
				schedule: newSchedule,
				script: newScript,
				enabled: true
			})
		});
		busy = false;
		if (!r.ok) {
			showToast(`Add automation failed: ${r.data?.error || 'unknown error'}`, 'error');
			return;
		}
		newName = '';
		await loadAutomations();
		showToast('Automation added', 'success');
	}

	async function toggleAutomation(automation: Automation) {
		const r = await api('/automations/update', {
			method: 'POST',
			body: JSON.stringify({ ...automation, enabled: !automation.enabled })
		});
		if (!r.ok) {
			showToast(`Update failed: ${r.data?.error || 'unknown error'}`, 'error');
			return;
		}
		await loadAutomations();
		showToast(`Automation ${automation.name}: ${automation.enabled ? 'disabled' : 'enabled'}`, 'success');
	}

	async function deleteAutomation(automation: Automation) {
		const r = await api('/automations/delete', {
			method: 'POST',
			body: JSON.stringify({ id: automation.id })
		});
		if (!r.ok) {
			showToast(`Delete failed: ${r.data?.error || 'unknown error'}`, 'error');
			return;
		}
		await loadAutomations();
		showToast(`Automation ${automation.name}: deleted`, 'success');
	}

	async function runAutomation(automation: Automation) {
		const r = await api('/automations/trigger', {
			method: 'POST',
			body: JSON.stringify({ id: automation.id })
		});
		if (!r.ok || r.data?.ok === false) {
			showToast(`Run failed: ${r.data?.error || 'unknown error'}`, 'error');
			return;
		}
		showToast(`Automation ${automation.name}: triggered`, 'success');
		await loadAutomations();
		await loadAutomationLogs(automation.id);
	}

	async function loadAutomationLogs(id: string) {
		selectedAutomation = id;
		const r = await api(`/automations/history?id=${encodeURIComponent(id)}&limit=20`);
		if (!r.ok) {
			automationLogs = `Failed to load automation logs: ${r.data?.error || 'unknown error'}`;
			return;
		}
		automationLogs = JSON.stringify(r.data?.logs ?? [], null, 2);
	}

	$effect(() => {
		if (hasToken) {
			loadServices();
			loadAutomations();
		}
	});
</script>

<div class="card">
	<h3>Container Management</h3>
	<p class="muted" style="font-size:13px">
		Start, stop, restart, update, and inspect logs for stack services. Admin and caddy are excluded.
	</p>
	{#if services.length === 0}
		<div class="muted" style="font-size:13px">No manageable services found.</div>
	{:else}
		<div style="display:grid;grid-template-columns:1fr auto;gap:0.5rem;align-items:center">
			{#each services as service}
				<div>
					<div style="font-family:ui-monospace, SFMono-Regular, Menlo, monospace">{service.name}</div>
					<div class="muted" style="font-size:12px">
						{service.image} • {service.status}
					</div>
				</div>
				<div style="display:flex;gap:0.25rem;flex-wrap:wrap;justify-content:flex-end">
					<button class="btn-secondary btn-sm" onclick={() => serviceAction('up', service.name)} disabled={busy}>Start</button>
					<button class="btn-secondary btn-sm" onclick={() => serviceAction('stop', service.name)} disabled={busy}>Stop</button>
					<button class="btn-secondary btn-sm" onclick={() => serviceAction('restart', service.name)} disabled={busy}>Restart</button>
					{#if service.updateAvailable}
						<button class="btn-secondary btn-sm" onclick={() => serviceAction('update', service.name)} disabled={busy}>Upgrade</button>
					{/if}
					<button class="btn-secondary btn-sm" onclick={() => loadServiceLogs(service.name)}>Logs</button>
				</div>
			{/each}
		</div>
	{/if}
	{#if selectedService}
		<div style="margin-top:0.6rem;font-size:12px" class="muted">Logs: {selectedService}</div>
		<textarea readonly rows="10" style="margin-top:0.3rem;width:100%">{serviceLogs}</textarea>
	{/if}
</div>

<div class="card">
	<h3>Automation Management</h3>
	<p class="muted" style="font-size:13px">
		Add, remove, enable/disable, run, and inspect logs for automations and cron jobs.
	</p>
	<div class="grid2" style="margin-bottom:0.6rem">
		<input bind:value={newName} placeholder="Automation name" />
		<input bind:value={newSchedule} placeholder="Cron schedule (e.g. */15 * * * *)" />
	</div>
	<textarea bind:value={newScript} rows="3" placeholder="Automation script"></textarea>
	<div style="margin-top:0.5rem">
		<button onclick={addAutomation} disabled={busy || !newName.trim() || !newSchedule.trim() || !newScript.trim()}>Add Automation</button>
	</div>
	<div style="margin-top:0.8rem;display:grid;grid-template-columns:1fr auto;gap:0.5rem;align-items:center">
		{#each automations as automation}
			<div>
				<div><strong>{automation.name}</strong> {automation.core ? '(core)' : ''}</div>
				<div class="muted" style="font-size:12px">
					{automation.schedule} • {automation.enabled ? 'enabled' : 'disabled'}
					{#if automation.lastRun}
						• last run {automation.lastRun.status} at {automation.lastRun.ts}
					{/if}
				</div>
			</div>
			<div style="display:flex;gap:0.25rem;flex-wrap:wrap;justify-content:flex-end">
				<button class="btn-secondary btn-sm" onclick={() => runAutomation(automation)}>Run</button>
				<button class="btn-secondary btn-sm" onclick={() => toggleAutomation(automation)}>{automation.enabled ? 'Disable' : 'Enable'}</button>
				<button class="btn-secondary btn-sm" onclick={() => loadAutomationLogs(automation.id)}>Logs</button>
				{#if !automation.core}
					<button class="btn-danger btn-sm" onclick={() => deleteAutomation(automation)}>Delete</button>
				{/if}
			</div>
		{/each}
	</div>
	{#if selectedAutomation}
		<div style="margin-top:0.6rem;font-size:12px" class="muted">Automation logs: {selectedAutomation}</div>
		<textarea readonly rows="10" style="margin-top:0.3rem;width:100%">{automationLogs}</textarea>
	{/if}
</div>
