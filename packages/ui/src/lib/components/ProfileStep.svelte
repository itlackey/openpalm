<script lang="ts">
	import { getSetupState } from '$lib/stores/setup.svelte';
	const setup = $derived(getSetupState());
</script>

<p class="muted">Tell OpenPalm who is running this workspace.</p>

<label style="display:block; margin:0.6rem 0 0.2rem" for="wiz-profile-name">Your name</label>
<input
	id="wiz-profile-name"
	placeholder="Taylor Palm"
	value={setup?.profile?.name ?? ''}
	autocomplete="name"
/>

<label style="display:block; margin:0.8rem 0 0.2rem" for="wiz-profile-email">Email</label>
<input
	id="wiz-profile-email"
	type="email"
	placeholder="you@example.com"
	value={setup?.profile?.email ?? ''}
	autocomplete="email"
/>
