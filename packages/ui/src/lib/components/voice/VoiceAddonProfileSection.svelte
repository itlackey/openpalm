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
	.engine-section { display: flex; flex-direction: column; gap: var(--space-3); }
	.engine-heading { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
</style>
