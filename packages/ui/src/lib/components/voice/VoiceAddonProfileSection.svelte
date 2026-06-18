<!--
  VoiceAddonProfileSection — presentation-only "Hardware profile" block for
  the admin VoiceTab. Shown when the OpenPalm Voice addon is selected and
  the host reports more than zero installable profiles. Wraps the shared
  VoiceProfileSelector. State lives in the VoiceTab orchestrator.
-->
<script lang="ts">
	import VoiceProfileSelector from '$lib/components/voice/VoiceProfileSelector.svelte';
	import type { VoiceAddonProfile } from '$lib/api.js';

	let {
		profiles,
		selectedProfile,
		onchange,
	}: {
		profiles: VoiceAddonProfile[];
		selectedProfile: string;
		onchange: (id: string) => void;
	} = $props();
</script>

<section class="engine-section">
	<h3 class="engine-heading">Hardware profile</h3>
	<VoiceProfileSelector {profiles} {selectedProfile} {onchange} />
</section>

<style>
	.engine-section {
		display: flex; flex-direction: column; gap: var(--s-sp-3);
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
		padding: var(--s-sp-5);
		background: none;
	}
	.engine-heading {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: var(--s-track-label);
		color: var(--s-ink-3);
		margin: 0;
		padding-bottom: var(--s-sp-3);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
	}
</style>
