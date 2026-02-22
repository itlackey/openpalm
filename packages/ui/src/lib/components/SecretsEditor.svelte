<script lang="ts">
	import { api } from '$lib/api';
	import { showToast } from '$lib/stores/toast.svelte';
	import { getAdminToken } from '$lib/stores/auth.svelte';

	let secretsText = $state('');
	let statusMsg = $state('');

	const hasToken = $derived(getAdminToken().length > 0);

	async function loadSecrets() {
		if (!hasToken) {
			secretsText = '(Enter admin password above to load)';
			return;
		}
		const r = await api('/secrets/raw');
		if (r.ok) {
			secretsText = typeof r.data === 'string' ? r.data : '';
		} else {
			secretsText = '# Could not load secrets: ' + (r.data?.error || 'unknown error');
		}
	}

	async function saveSecrets() {
		if (!hasToken) {
			showToast('Enter admin password first.', 'error');
			return;
		}
		const r = await api('/command', {
			method: 'POST',
			body: JSON.stringify({ type: 'secret.raw.set', payload: { content: secretsText } })
		});
		if (r.ok) {
			showToast('Secrets saved.', 'success');
			statusMsg = 'Saved. Apply the stack to propagate changes to services.';
		} else {
			showToast('Save failed: ' + (r.data?.error || 'unknown'), 'error');
			statusMsg = '';
		}
	}

	$effect(() => {
		if (hasToken) {
			loadSecrets();
		}
	});
</script>

<div class="card">
	<h3>Secrets</h3>
	<p class="muted" style="font-size:13px">
		Edit the secrets.env file directly. Each line is <code>KEY=value</code>. After saving,
		apply the stack to propagate changes to services.
	</p>
	<textarea bind:value={secretsText} rows="10" style="width:100%;margin:0.5rem 0" placeholder="Loading..."></textarea>
	<div style="display:flex;gap:0.5rem">
		<button onclick={saveSecrets}>Save Secrets</button>
		<button class="btn-secondary" onclick={loadSecrets}>Reload</button>
	</div>
	{#if statusMsg}
		<div style="margin-top:0.5rem;font-size:13px" class="muted">{statusMsg}</div>
	{/if}
</div>
