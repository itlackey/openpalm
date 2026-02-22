<script lang="ts">
	import { getAdminToken, setAdminToken } from '$lib/stores/auth.svelte';
	import { showToast } from '$lib/stores/toast.svelte';
	import { api } from '$lib/api';

	let tokenInput = $state(getAdminToken());

	async function saveToken() {
		try {
			const res = await fetch(`${import.meta.env.BASE_URL ?? '/'}installed`, {
				headers: {
					'content-type': 'application/json',
					'x-admin-token': tokenInput
				}
			});
			if (res.status === 401) {
				showToast('Invalid admin password.', 'error');
				return;
			}
		} catch {
			// ignore network errors during validation
		}
		setAdminToken(tokenInput);
		showToast('Password saved.', 'success');
	}
</script>

<div class="card">
	<h3>Admin Password</h3>
	<p class="muted" style="font-size:13px">
		Enter your <code>ADMIN_TOKEN</code> from secrets.env to authenticate.
	</p>
	<div style="display:flex;gap:0.5rem">
		<input type="password" bind:value={tokenInput} style="flex:1" />
		<button onclick={saveToken}>Save</button>
	</div>
</div>
