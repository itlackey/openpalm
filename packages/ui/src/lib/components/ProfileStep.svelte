<script lang="ts">
	import { getSetupState } from '$lib/stores/setup.svelte';

	interface Props {
		error: string;
	}

	let { error }: Props = $props();
	const setup = $derived(getSetupState());
</script>

<p class="muted">Tell OpenPalm who is running this workspace.</p>

{#if error}
	<div class="wiz-error visible">{error}</div>
{/if}

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

<label style="display:block; margin:0.8rem 0 0.2rem" for="wiz-profile-password">Admin password</label>
<input
	id="wiz-profile-password"
	type="password"
	placeholder="Choose a password (min 8 characters)"
	autocomplete="new-password"
/>

<label style="display:block; margin:0.8rem 0 0.2rem" for="wiz-profile-password2">Confirm password</label>
<input
	id="wiz-profile-password2"
	type="password"
	placeholder="Repeat password"
	autocomplete="new-password"
/>
