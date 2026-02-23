<script lang="ts">
	import { api } from '$lib/api';
	import { showToast } from '$lib/stores/toast.svelte';
	import { getAdminToken } from '$lib/stores/auth.svelte';

	let specText = $state('');
	let statusMsg = $state('');

	const hasToken = $derived(getAdminToken().length > 0);

	async function loadSpec() {
		if (!hasToken) {
			specText = '(Enter admin password above to load)';
			return;
		}
		const r = await api('/stack/spec');
		if (r.ok && r.data?.yaml) {
			specText = r.data.yaml;
		} else {
			specText = '# Could not load stack spec: ' + (r.data?.error || 'unknown error');
		}
	}

	async function saveSpec() {
		if (!hasToken) {
			showToast('Enter admin password first.', 'error');
			return;
		}
		const r = await api('/stack/spec', {
			method: 'POST',
			body: JSON.stringify({ yaml: specText })
		});
		if (r.ok) {
			specText = r.data.yaml;
			showToast('Stack spec saved.', 'success');
			statusMsg = 'Saved. Click "Apply Changes" to regenerate configs and restart services.';
		} else {
			showToast('Save failed: ' + (r.data?.error || r.data?.details || 'unknown'), 'error');
			statusMsg = '';
		}
	}

	async function applyStack() {
		if (!hasToken) {
			showToast('Enter admin password first.', 'error');
			return;
		}
		statusMsg = 'Applying...';
		const r = await api('/stack/apply', { method: 'POST' });
		if (r.ok) {
			showToast('Stack applied successfully.', 'success');
			const impact = r.data?.impact || {};
			const parts: string[] = [];
			if (impact.restart?.length) parts.push('Restarted: ' + impact.restart.join(', '));
			if (impact.reload?.length) parts.push('Reloaded: ' + impact.reload.join(', '));
			if (impact.up?.length) parts.push('Started: ' + impact.up.join(', '));
			statusMsg = parts.length ? parts.join('. ') : 'Applied (no changes detected).';
		} else {
			showToast(
				'Apply failed: ' + (r.data?.error || r.data?.details || 'unknown'),
				'error'
			);
			statusMsg = '';
		}
	}

	$effect(() => {
		if (hasToken) {
			loadSpec();
		}
	});
</script>

<div class="card">
	<h3>Stack Spec</h3>
	<p class="muted" style="font-size:13px">
		Edit the stack specification (YAML) to configure channels, automations, and access scope.
		Save, then Apply to regenerate configuration files and restart services.
	</p>
	<textarea bind:value={specText} rows="16" style="width:100%;margin:0.5rem 0" placeholder="Loading..."></textarea>
	<div style="display:flex;gap:0.5rem">
		<button onclick={saveSpec}>Save Spec</button>
		<button class="btn-secondary" onclick={applyStack}>Apply Changes</button>
		<button class="btn-secondary" onclick={loadSpec}>Reload</button>
	</div>
	{#if statusMsg}
		<div style="margin-top:0.5rem;font-size:13px" class="muted">{statusMsg}</div>
	{/if}
</div>
