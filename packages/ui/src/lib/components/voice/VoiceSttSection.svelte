<!--
  VoiceSttSection — presentation-only Speech-to-Text section for the admin
  VoiceTab. Thin wrapper around the shared VoiceEngineSelector with the
  STT heading. All state and handlers live in the VoiceTab orchestrator.
-->
<script lang="ts">
	import VoiceEngineSelector from '$lib/components/voice/VoiceEngineSelector.svelte';
	import type {
		SttOption,
		VoiceEngineConfig,
		VoiceEngineValue,
	} from '$lib/wizard/types.js';

	let {
		value,
		onchange,
		engineOptions,
		engineConfigs,
		reachable,
		disabledEngines,
		hiddenEngines,
	}: {
		value: VoiceEngineValue;
		onchange: (next: VoiceEngineValue) => void;
		engineOptions: SttOption[];
		engineConfigs: Record<string, VoiceEngineConfig>;
		reachable?: { remoteConfigured: boolean; remoteReachable: boolean };
		disabledEngines?: Record<string, { disabled: boolean; reason?: string }>;
		hiddenEngines?: Set<string>;
	} = $props();
</script>

<section class="engine-section">
	<h3 class="engine-heading">Speech-to-Text</h3>
	<p class="engine-subheading">How your assistant listens</p>

	<VoiceEngineSelector
		kind="stt"
		{value}
		{onchange}
		{engineOptions}
		{engineConfigs}
		{reachable}
		reachabilityEngineId="remote"
		{disabledEngines}
		{hiddenEngines}
	/>
</section>

<style>
	.engine-section { display: flex; flex-direction: column; gap: var(--space-3); }
	.engine-heading { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.engine-subheading { font-size: var(--text-xs); color: var(--color-text-secondary); margin: 0; }
</style>
