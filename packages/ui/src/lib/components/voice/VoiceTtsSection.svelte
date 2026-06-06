<!--
  VoiceTtsSection — presentation-only Text-to-Speech section for the admin
  VoiceTab. Wraps the shared VoiceEngineSelector and, once an engine is
  picked, the "Test voice" button + auto-speak toggle.

  All state and handlers live in the VoiceTab orchestrator; this component
  receives them via props/callbacks. The engine value is owned by the
  parent (read via `value`, mutated via `onchange`).
-->
<script lang="ts">
	import Spinner from '$lib/components/common/Spinner.svelte';
	import VoiceEngineSelector from '$lib/components/voice/VoiceEngineSelector.svelte';
	import type {
		TtsOption,
		VoiceEngineConfig,
		VoiceEngineValue,
	} from '$lib/wizard/types.js';

	let {
		value,
		onchange,
		engineOptions,
		engineConfigs,
		reachable,
		hiddenEngines,
		engineSelected,
		ttsAutoEnabled,
		onAutoEnabledChange,
		testingVoice,
		testResult,
		testError,
		onTest,
		busy,
	}: {
		value: VoiceEngineValue;
		onchange: (next: VoiceEngineValue) => void;
		engineOptions: TtsOption[];
		engineConfigs: Record<string, VoiceEngineConfig>;
		reachable?: { remoteConfigured: boolean; remoteReachable: boolean };
		hiddenEngines?: Set<string>;
		/** Whether an engine has been chosen — gates the extras block. */
		engineSelected: boolean;
		ttsAutoEnabled: boolean;
		onAutoEnabledChange: (checked: boolean) => void;
		testingVoice: boolean;
		testResult: 'success' | 'error' | null;
		testError: string;
		onTest: () => void;
		/** Parent loading/saving flag — disables the Test button. */
		busy: boolean;
	} = $props();
</script>

<section class="engine-section">
	<h3 class="engine-heading">Text-to-Speech</h3>
	<p class="engine-subheading">How your assistant speaks</p>

	<VoiceEngineSelector
		kind="tts"
		{value}
		{onchange}
		{engineOptions}
		{engineConfigs}
		{reachable}
		reachabilityEngineId="remote"
		{hiddenEngines}
	/>

	{#if engineSelected}
		<div class="tts-extras">
			<div class="test-voice-row">
				<button
					type="button"
					class="btn btn-secondary btn-sm"
					onclick={() => onTest()}
					disabled={testingVoice || busy}
				>
					{#if testingVoice}<Spinner size={12} />{/if}
					Test voice
				</button>
				{#if testResult === 'success'}
					<span class="test-result test-result--ok" aria-live="polite">
						<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
						Working
					</span>
				{:else if testResult === 'error'}
					<span class="test-result test-result--err" aria-live="polite">
						<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						{testError || 'Failed'}
					</span>
				{/if}
			</div>

			<label class="auto-speak-toggle">
				<input
					type="checkbox"
					checked={ttsAutoEnabled}
					onchange={(e) => onAutoEnabledChange((e.currentTarget as HTMLInputElement).checked)}
				/>
				<span>Speak assistant replies aloud automatically</span>
			</label>
		</div>
	{/if}
</section>

<style>
	.engine-section { display: flex; flex-direction: column; gap: var(--space-3); }
	.engine-heading { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.engine-subheading { font-size: var(--text-xs); color: var(--color-text-secondary); margin: 0; }

	.tts-extras {
		display: flex; flex-direction: column; gap: var(--space-3);
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}
	.test-voice-row {
		display: flex; align-items: center; gap: var(--space-3);
	}
	.test-result {
		font-size: var(--text-xs);
	}
	.test-result--ok { color: var(--color-success, #16a34a); }
	.test-result--err { color: var(--color-error, #dc2626); }
	.auto-speak-toggle {
		display: flex; align-items: center; gap: var(--space-2);
		font-size: var(--text-sm); color: var(--color-text);
		cursor: pointer;
	}
	.auto-speak-toggle input[type='checkbox'] {
		width: 16px; height: 16px; cursor: pointer;
	}
</style>
