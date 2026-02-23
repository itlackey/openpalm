<script lang="ts">
	import { api } from '$lib/api';
	import { getSetupState, setSetupState } from '$lib/stores/setup.svelte';

	const setup = $derived(getSetupState());
	let name = $state('');
	let email = $state('');
	let saving = $state(false);
	let saved = $state(false);
	let error = $state('');

	$effect(() => {
		name = setup?.profile?.name ?? '';
		email = setup?.profile?.email ?? '';
	});

	async function saveProfile() {
		error = '';
		saved = false;
		saving = true;
		const result = await api('/command', {
			method: 'POST',
			body: JSON.stringify({ type: 'setup.profile', payload: { name, email } })
		});
		saving = false;
		if (!result.ok) {
			error = 'Could not save profile settings.';
			return;
		}
		setSetupState({
			...(setup ?? result.data.state),
			profile: result.data.profile
		});
		saved = true;
	}
</script>

<div class="card profile-card">
	<h3>👋 Team Profile</h3>
	<p class="muted" style="font-size:13px; margin-top:0.2rem">
		Used by OpenPalm generator and assistant runtime environment.
	</p>
	<div class="grid2" style="margin-top:0.8rem">
		<div>
			<label for="profile-name">Name</label>
			<input id="profile-name" bind:value={name} placeholder="Taylor Palm" autocomplete="name" />
		</div>
		<div>
			<label for="profile-email">Email</label>
			<input
				id="profile-email"
				type="email"
				bind:value={email}
				placeholder="you@example.com"
				autocomplete="email"
			/>
		</div>
	</div>
	<div style="display:flex; gap:0.6rem; align-items:center; margin-top:0.8rem">
		<button onclick={saveProfile} disabled={saving}>{saving ? 'Saving…' : 'Save Profile'}</button>
		{#if saved}
			<span class="muted">Saved.</span>
		{/if}
		{#if error}
			<span style="color:var(--red)">{error}</span>
		{/if}
	</div>
</div>
