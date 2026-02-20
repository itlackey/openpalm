<script lang="ts">
	import { apiGet, apiPost } from '$lib/api';
	import { showToast } from '$lib/stores/toast';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import type { Automation } from '$lib/types';

	/* ── state ─────────────────────────────────────────── */

	let automations = $state<Automation[]>([]);
	let loading = $state(true);
	let creating = $state(false);

	/* create form */
	let newName = $state('');
	let newPrompt = $state('');
	let newSchedule = $state('0 * * * *');
	let showCreateForm = $state(false);

	/* edit state */
	let editingId = $state<string | null>(null);
	let editName = $state('');
	let editPrompt = $state('');
	let editSchedule = $state('');
	let saving = $state(false);

	/* delete confirmation */
	let confirmDeleteId = $state<string | null>(null);
	let deleting = $state(false);

	/* trigger (run now) */
	let triggeringId = $state<string | null>(null);

	/* ── cron presets ──────────────────────────────────── */

	const cronPresets = [
		{ label: 'Every 30 min', cron: '*/30 * * * *' },
		{ label: 'Hourly', cron: '0 * * * *' },
		{ label: 'Daily 9am', cron: '0 9 * * *' },
		{ label: 'Weekly Monday', cron: '0 9 * * 1' }
	] as const;

	function cronToHuman(cron: string): string {
		switch (cron) {
			case '*/30 * * * *': return 'Every 30 minutes';
			case '0 * * * *': return 'Every hour';
			case '0 9 * * *': return 'Daily at 9:00 AM';
			case '0 9 * * 1': return 'Weekly on Monday at 9:00 AM';
			default: return cron;
		}
	}

	/* ── fetch automations ─────────────────────────────── */

	async function fetchAutomations() {
		loading = true;
		const res = await apiGet<{ automations: Automation[] }>('/admin/automations');
		if (res.ok && res.data?.automations) {
			automations = res.data.automations;
		} else {
			showToast('Failed to load automations', 'error');
		}
		loading = false;
	}

	$effect(() => {
		fetchAutomations();
	});

	/* ── create ────────────────────────────────────────── */

	async function handleCreate() {
		if (!newName.trim() || !newPrompt.trim()) {
			showToast('Name and prompt are required', 'error');
			return;
		}
		creating = true;
		const res = await apiPost<{ ok: boolean; automation: Automation }>(
			'/admin/automations',
			{ name: newName.trim(), schedule: newSchedule, prompt: newPrompt.trim() }
		);
		if (res.ok && res.data?.ok) {
			automations = [res.data.automation, ...automations];
			newName = '';
			newPrompt = '';
			newSchedule = '0 * * * *';
			showCreateForm = false;
			showToast('Automation created', 'success');
		} else {
			showToast('Failed to create automation', 'error');
		}
		creating = false;
	}

	/* ── edit ──────────────────────────────────────────── */

	function startEdit(a: Automation) {
		editingId = a.id;
		editName = a.name;
		editPrompt = a.prompt;
		editSchedule = a.schedule;
		confirmDeleteId = null;
	}

	function cancelEdit() {
		editingId = null;
	}

	async function handleSave() {
		if (!editingId) return;
		if (!editName.trim() || !editPrompt.trim()) {
			showToast('Name and prompt are required', 'error');
			return;
		}
		saving = true;
		const res = await apiPost<{ ok: boolean; automation: Automation }>(
			'/admin/automations/update',
			{ id: editingId, name: editName.trim(), schedule: editSchedule, prompt: editPrompt.trim() }
		);
		if (res.ok && res.data?.ok) {
			automations = automations.map((a) =>
				a.id === editingId ? res.data.automation : a
			);
			editingId = null;
			showToast('Automation updated', 'success');
		} else {
			showToast('Failed to update automation', 'error');
		}
		saving = false;
	}

	/* ── toggle status ────────────────────────────────── */

	async function toggleStatus(a: Automation) {
		const newStatus = a.status === 'enabled' ? 'disabled' : 'enabled';
		const res = await apiPost<{ ok: boolean; automation: Automation }>(
			'/admin/automations/update',
			{ id: a.id, status: newStatus }
		);
		if (res.ok && res.data?.ok) {
			automations = automations.map((item) =>
				item.id === a.id ? res.data.automation : item
			);
			showToast(`Automation ${newStatus}`, 'success');
		} else {
			showToast('Failed to toggle status', 'error');
		}
	}

	/* ── delete ────────────────────────────────────────── */

	async function handleDelete(id: string) {
		deleting = true;
		const res = await apiPost<{ ok: boolean; deleted: boolean }>(
			'/admin/automations/delete',
			{ id }
		);
		if (res.ok && res.data?.ok) {
			automations = automations.filter((a) => a.id !== id);
			confirmDeleteId = null;
			showToast('Automation deleted', 'success');
		} else {
			showToast('Failed to delete automation', 'error');
		}
		deleting = false;
	}

	/* ── trigger (run now) ─────────────────────────────── */

	async function handleTrigger(id: string) {
		triggeringId = id;
		const res = await apiPost<{ ok: boolean; triggered: boolean }>(
			'/admin/automations/trigger',
			{ id }
		);
		if (res.ok && res.data?.ok) {
			showToast('Automation triggered', 'success');
		} else {
			showToast('Failed to trigger automation', 'error');
		}
		triggeringId = null;
	}

	/* ── helpers ───────────────────────────────────────── */

	function truncate(text: string, maxLen: number): string {
		if (text.length <= maxLen) return text;
		return text.slice(0, maxLen) + '...';
	}

	function formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleDateString(undefined, {
				year: 'numeric',
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			});
		} catch {
			return iso;
		}
	}
</script>

<div class="container">
	<div class="page-header">
		<h1>Automations</h1>
		<button
			class="btn-sm"
			class:btn-secondary={showCreateForm}
			onclick={() => { showCreateForm = !showCreateForm; confirmDeleteId = null; }}
		>
			{showCreateForm ? 'Cancel' : '+ New Automation'}
		</button>
	</div>

	<!-- ── Create Form ───────────────────────────────── -->
	{#if showCreateForm}
		<div class="card create-card" role="region" aria-label="Create new automation">
			<h2>Create Automation</h2>

			<div class="form-group">
				<label for="create-name">Name</label>
				<input
					id="create-name"
					type="text"
					bind:value={newName}
					placeholder="e.g. Daily Summary"
					disabled={creating}
				/>
			</div>

			<div class="form-group">
				<label for="create-prompt">Prompt</label>
				<textarea
					id="create-prompt"
					bind:value={newPrompt}
					placeholder="What should this automation do?"
					rows="3"
					disabled={creating}
				></textarea>
			</div>

			<div class="form-group">
				<label for="create-schedule">Schedule</label>
				<div class="preset-row">
					{#each cronPresets as preset}
						<button
							type="button"
							class="btn-sm preset-btn"
							class:preset-active={newSchedule === preset.cron}
							onclick={() => { newSchedule = preset.cron; }}
							disabled={creating}
						>
							{preset.label}
						</button>
					{/each}
				</div>
				<input
					id="create-schedule"
					type="text"
					bind:value={newSchedule}
					placeholder="Cron expression, e.g. 0 * * * *"
					disabled={creating}
				/>
				<p class="help-text">
					{cronToHuman(newSchedule)}
				</p>
			</div>

			<div class="form-actions">
				<button
					onclick={handleCreate}
					disabled={creating || !newName.trim() || !newPrompt.trim()}
				>
					{#if creating}
						Creating...
					{:else}
						Create Automation
					{/if}
				</button>
				<button
					class="btn-secondary"
					onclick={() => { showCreateForm = false; }}
					disabled={creating}
				>
					Cancel
				</button>
			</div>
		</div>
	{/if}

	<!-- ── Loading ────────────────────────────────────── -->
	{#if loading}
		<LoadingSpinner message="Loading automations..." />
	{:else if automations.length === 0}
		<!-- ── Empty State ──────────────────────────────── -->
		<div class="empty-state">
			<div class="empty-icon" aria-hidden="true">
				<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10" />
					<polyline points="12 6 12 12 16 14" />
				</svg>
			</div>
			<h2>No automations yet</h2>
			<p>Automations run prompts on a schedule. Create your first one to get started.</p>
			{#if !showCreateForm}
				<button onclick={() => { showCreateForm = true; }}>
					+ New Automation
				</button>
			{/if}
		</div>
	{:else}
		<!-- ── Automation List ──────────────────────────── -->
		<div class="automation-list" role="list">
			{#each automations as automation (automation.id)}
				<div
					class="card automation-card"
					class:card-disabled={automation.status === 'disabled'}
					role="listitem"
				>
					{#if editingId === automation.id}
						<!-- ── Edit Mode ────────────────────── -->
						<div class="edit-form" role="region" aria-label="Edit automation {automation.name}">
							<div class="form-group">
								<label for="edit-name-{automation.id}">Name</label>
								<input
									id="edit-name-{automation.id}"
									type="text"
									bind:value={editName}
									disabled={saving}
								/>
							</div>

							<div class="form-group">
								<label for="edit-prompt-{automation.id}">Prompt</label>
								<textarea
									id="edit-prompt-{automation.id}"
									bind:value={editPrompt}
									rows="3"
									disabled={saving}
								></textarea>
							</div>

							<div class="form-group">
								<label for="edit-schedule-{automation.id}">Schedule</label>
								<div class="preset-row">
									{#each cronPresets as preset}
										<button
											type="button"
											class="btn-sm preset-btn"
											class:preset-active={editSchedule === preset.cron}
											onclick={() => { editSchedule = preset.cron; }}
											disabled={saving}
										>
											{preset.label}
										</button>
									{/each}
								</div>
								<input
									id="edit-schedule-{automation.id}"
									type="text"
									bind:value={editSchedule}
									placeholder="Cron expression"
									disabled={saving}
								/>
								<p class="help-text">
									{cronToHuman(editSchedule)}
								</p>
							</div>

							<div class="form-actions">
								<button
									onclick={handleSave}
									disabled={saving || !editName.trim() || !editPrompt.trim()}
								>
									{#if saving}
										Saving...
									{:else}
										Save Changes
									{/if}
								</button>
								<button
									class="btn-secondary"
									onclick={cancelEdit}
									disabled={saving}
								>
									Cancel
								</button>
							</div>
						</div>
					{:else}
						<!-- ── Card Display Mode ────────────── -->
						<div class="card-header">
							<div class="card-title-row">
								<h3>{automation.name}</h3>
								<button
									class="status-toggle"
									class:status-enabled={automation.status === 'enabled'}
									class:status-disabled={automation.status === 'disabled'}
									onclick={() => toggleStatus(automation)}
									aria-label="{automation.status === 'enabled' ? 'Disable' : 'Enable'} automation {automation.name}"
									title="{automation.status === 'enabled' ? 'Enabled - click to disable' : 'Disabled - click to enable'}"
								>
									<span class="status-dot" aria-hidden="true"></span>
									<span class="status-label">{automation.status === 'enabled' ? 'Enabled' : 'Disabled'}</span>
								</button>
							</div>
							<div class="card-meta">
								<span class="schedule-badge" title={automation.schedule}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<circle cx="12" cy="12" r="10" />
										<polyline points="12 6 12 12 16 14" />
									</svg>
									{cronToHuman(automation.schedule)}
								</span>
								<span class="muted created-date">
									Created {formatDate(automation.createdAt)}
								</span>
							</div>
						</div>

						<div class="card-body">
							<p class="prompt-preview" title={automation.prompt}>
								{truncate(automation.prompt, 160)}
							</p>
						</div>

						<!-- ── Delete Confirmation ──────────── -->
						{#if confirmDeleteId === automation.id}
							<div
								class="delete-confirm"
								role="status"
								aria-label="Confirm deletion of {automation.name}"
							>
								<span>Delete <strong>{automation.name}</strong>? This cannot be undone.</span>
								<div class="confirm-actions">
									<button
										class="btn-danger btn-sm"
										onclick={() => handleDelete(automation.id)}
										disabled={deleting}
									>
										{#if deleting}
											Deleting...
										{:else}
											Yes, Delete
										{/if}
									</button>
									<button
										class="btn-secondary btn-sm"
										onclick={() => { confirmDeleteId = null; }}
										disabled={deleting}
									>
										Cancel
									</button>
								</div>
							</div>
						{/if}

						<!-- ── Action Buttons ──────────────── -->
						<div class="card-actions">
							<button
								class="btn-sm btn-secondary"
								onclick={() => startEdit(automation)}
								disabled={editingId !== null}
							>
								Edit
							</button>
							<button
								class="btn-sm btn-secondary btn-run"
								onclick={() => handleTrigger(automation.id)}
								disabled={triggeringId === automation.id}
							>
								{#if triggeringId === automation.id}
									Running...
								{:else}
									Run Now
								{/if}
							</button>
							<button
								class="btn-sm btn-secondary btn-delete-trigger"
								onclick={() => {
									confirmDeleteId = confirmDeleteId === automation.id ? null : automation.id;
								}}
								aria-expanded={confirmDeleteId === automation.id}
								disabled={deleting && confirmDeleteId === automation.id}
							>
								Delete
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* ── page header ───────────────────────────── */
	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1.5rem;
	}
	.page-header h1 {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 700;
	}

	/* ── create card ───────────────────────────── */
	.create-card {
		border-color: var(--accent);
		margin-bottom: 1.5rem;
	}
	.create-card h2 {
		margin: 0 0 1rem;
		font-size: 1.1rem;
		font-weight: 600;
	}

	/* ── cron preset row ───────────────────────── */
	.preset-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 0.5rem;
	}
	.preset-btn {
		background: var(--surface2);
		color: var(--muted);
		border: 1px solid var(--border);
		font-size: 12px;
		padding: 0.25rem 0.6rem;
		transition: all 0.15s;
	}
	.preset-btn:hover {
		color: var(--text);
		border-color: var(--accent);
	}
	.preset-active {
		background: var(--accent);
		color: #fff;
		border-color: var(--accent);
	}
	.preset-active:hover {
		color: #fff;
	}

	/* ── form actions ──────────────────────────── */
	.form-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	/* ── automation card ───────────────────────── */
	.automation-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}
	.automation-card {
		transition: border-color 0.15s;
	}
	.automation-card:hover {
		border-color: var(--accent);
	}
	.card-disabled {
		opacity: 0.6;
	}

	/* ── card header ───────────────────────────── */
	.card-header {
		margin-bottom: 0.75rem;
	}
	.card-title-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.35rem;
	}
	.card-title-row h3 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ── status toggle ─────────────────────────── */
	.status-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		background: var(--surface2);
		border: 1px solid var(--border);
		border-radius: 20px;
		padding: 0.2rem 0.65rem;
		font-size: 12px;
		cursor: pointer;
		flex-shrink: 0;
		transition: all 0.15s;
	}
	.status-toggle:hover {
		border-color: var(--accent);
	}
	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}
	.status-enabled .status-dot {
		background: var(--green);
		box-shadow: 0 0 6px var(--green);
	}
	.status-enabled .status-label {
		color: var(--green);
	}
	.status-disabled .status-dot {
		background: var(--muted);
	}
	.status-disabled .status-label {
		color: var(--muted);
	}

	/* ── card meta ─────────────────────────────── */
	.card-meta {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.schedule-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 13px;
		color: var(--accent2);
	}
	.created-date {
		font-size: 12px;
	}

	/* ── card body ─────────────────────────────── */
	.card-body {
		margin-bottom: 0.75rem;
	}
	.prompt-preview {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* ── delete confirmation ───────────────────── */
	.delete-confirm {
		background: var(--surface2);
		border: 1px solid var(--red);
		border-radius: var(--radius);
		padding: 0.75rem 1rem;
		margin-bottom: 0.75rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		font-size: 14px;
	}
	.confirm-actions {
		display: flex;
		gap: 0.4rem;
		flex-shrink: 0;
	}

	/* ── card actions ──────────────────────────── */
	.card-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
	.btn-run:hover {
		border-color: var(--green);
		color: var(--green);
	}
	.btn-delete-trigger:hover {
		border-color: var(--red);
		color: var(--red);
	}

	/* ── edit form inside card ─────────────────── */
	.edit-form {
		padding: 0;
	}

	/* ── empty state ───────────────────────────── */
	.empty-icon {
		color: var(--muted);
		margin-bottom: 1rem;
	}
	.empty-state h2 {
		margin: 0 0 0.5rem;
		font-size: 1.2rem;
	}
	.empty-state p {
		margin: 0 0 1.25rem;
		max-width: 360px;
		margin-left: auto;
		margin-right: auto;
	}

	/* ── responsive ────────────────────────────── */
	@media (max-width: 600px) {
		.page-header h1 {
			font-size: 1.2rem;
		}
		.card-title-row {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.4rem;
		}
		.card-meta {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.3rem;
		}
		.delete-confirm {
			flex-direction: column;
			align-items: flex-start;
		}
		.card-actions {
			flex-direction: column;
		}
		.card-actions button {
			width: 100%;
		}
	}
</style>
