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
	} from '$lib/client/types.js';

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
	.engine-subheading {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-2);
		margin: 0;
	}
</style>
