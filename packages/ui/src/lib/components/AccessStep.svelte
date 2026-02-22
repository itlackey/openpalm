<script lang="ts">
	import { getSetupState } from '$lib/stores/setup.svelte';

	interface Props {
		error: string;
	}

	let { error }: Props = $props();

	const state = $derived(getSetupState());
	const accessScope = $derived(state?.accessScope ?? 'host');
</script>

<p>Choose who can access your assistant.</p>

{#if error}
	<div class="wiz-error visible">{error}</div>
{/if}

<label class="card" style="display:flex;gap:0.7rem;align-items:start;cursor:pointer">
	<input
		type="radio"
		name="wiz-scope"
		value="host"
		checked={accessScope === 'host'}
		style="width:auto;margin-top:4px"
	/>
	<div>
		<strong>Just this computer</strong>
		<div class="muted" style="font-size:13px">
			Only accessible from this device. Most secure option.
		</div>
	</div>
</label>

<label class="card" style="display:flex;gap:0.7rem;align-items:start;cursor:pointer">
	<input
		type="radio"
		name="wiz-scope"
		value="lan"
		checked={accessScope === 'lan'}
		style="width:auto;margin-top:4px"
	/>
	<div>
		<strong>Any device on my home network</strong>
		<div class="muted" style="font-size:13px">
			Other devices on your local network can access your assistant.
		</div>
	</div>
</label>
