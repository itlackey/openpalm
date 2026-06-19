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
	import IconDone from '$lib/components/icons/IconDone.svelte';
	import IconClose from '$lib/components/icons/IconClose.svelte';
	import VoiceEngineSelector from '$lib/components/voice/VoiceEngineSelector.svelte';
	import type {
		TtsOption,
		VoiceEngineConfig,
		VoiceEngineValue,
	} from '$lib/client/types.js';

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
						<IconDone size={14} />
						Working
					</span>
				{:else if testResult === 'error'}
					<span class="test-result test-result--err" aria-live="polite">
						<IconClose size={14} />
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

	.tts-extras {
		display: flex; flex-direction: column; gap: var(--s-sp-3);
		margin-top: var(--s-sp-3);
		padding-top: var(--s-sp-3);
		border-top: var(--s-hair) solid var(--s-line-soft);
	}
	.test-voice-row {
		display: flex; align-items: center; gap: var(--s-sp-3);
	}
	.test-result {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		display: flex; align-items: center; gap: var(--s-sp-1);
	}
	.test-result--ok { color: var(--s-moss); }
	.test-result--err { color: var(--s-seal); }
	.auto-speak-toggle {
		display: flex; align-items: center; gap: var(--s-sp-2);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-2);
		cursor: pointer;
	}
	.auto-speak-toggle input[type='checkbox'] {
		width: 14px; height: 14px; cursor: pointer;
		accent-color: var(--s-seal);
	}
</style>
