<!--
  VoiceEngineSelector — shared TTS/STT picker for the setup wizard and
  the admin VoiceTab. Renders engine cards; when an engine has
  configurable fields, they appear inline beneath the selected card.

  Data shape it owns:
    { engine: string, provider?, model?, voice?, language? }

  Pass it via `value` and react to `onchange`.
-->
<script lang="ts">
	import {
		TTS_OPTIONS,
		STT_OPTIONS,
		TTS_ENGINES,
		STT_ENGINES,
	} from '$lib/wizard/constants.js';
	import type {
		SttOption,
		TtsOption,
		VoiceEngineConfig,
		VoiceEngineValue,
	} from '$lib/wizard/types.js';

	let {
		kind,
		value,
		onchange,
		reachable,
		reachabilityEngineId,
		disabledEngines,
		hiddenEngines,
		engineOptions,
		engineConfigs,
	}: {
		kind: 'tts' | 'stt';
		value: VoiceEngineValue;
		onchange: (next: VoiceEngineValue) => void;
		/** Remote endpoint reachability — shown as a badge on the remote engine card. */
		reachable?: { remoteConfigured: boolean; remoteReachable: boolean };
		/** Engine id that should show the reachability badge when `reachable` is present. */
		reachabilityEngineId?: string;
		/** Map of engine ID → disabled state. Disabled engines render with reduced opacity and cannot be selected. */
		disabledEngines?: Record<string, { disabled: boolean; reason?: string }>;
		/** Set of engine IDs to hide entirely (e.g. browser option when API unavailable). */
		hiddenEngines?: Set<string>;
		/** Optional caller-provided option list. Falls back to wizard defaults. */
		engineOptions?: (TtsOption | SttOption)[];
		/** Optional caller-provided engine config map. Falls back to wizard defaults. */
		engineConfigs?: Record<string, VoiceEngineConfig>;
	} = $props();

	const allOptions = $derived(engineOptions ?? (kind === 'tts' ? TTS_OPTIONS : STT_OPTIONS));
	const engines = $derived(engineConfigs ?? (kind === 'tts' ? TTS_ENGINES : STT_ENGINES));

	const options = $derived(
		hiddenEngines ? allOptions.filter((o) => !hiddenEngines.has(o.id)) : allOptions,
	);

	function selectEngine(id: string) {
		if (disabledEngines?.[id]?.disabled) return;
		const config = engines[id];
		// Drop fields that aren't supported by this engine to keep stack.yml clean
		const allowed = new Set(config?.fields.map((f) => f.key));
		const next: VoiceEngineValue = {
			engine: id,
			provider: config?.provider,
			...(allowed.has('baseURL') && value.baseURL ? { baseURL: value.baseURL } : {}),
			...(allowed.has('model') && value.model ? { model: value.model } : {}),
			...(allowed.has('voice') && value.voice ? { voice: value.voice } : {}),
			...(allowed.has('language') && value.language ? { language: value.language } : {}),
		};
		onchange(next);
	}

	function updateField(key: 'baseURL' | 'model' | 'voice' | 'language', val: string) {
		const next: VoiceEngineValue = { ...value };
		if (val) next[key] = val;
		else delete next[key];
		onchange(next);
	}
</script>

<div class="engine-list">
	{#each options as o (o.id)}
		{@const selected = value.engine === o.id}
		{@const config = engines[o.id]}
		{@const engineState = disabledEngines?.[o.id]}
		{@const isDisabled = engineState?.disabled ?? false}
		<button
			type="button"
			class="engine-card"
			class:engine-card--selected={selected}
			class:engine-card--disabled={isDisabled}
			disabled={isDisabled}
			onclick={() => selectEngine(o.id)}
		>
			<div class="engine-body">
				<span class="engine-name">{o.name}</span>
				<span class="engine-desc">{o.desc}</span>
				{#if isDisabled && engineState?.reason}
					<span class="engine-subtitle">{engineState.reason}</span>
				{/if}
				{#if o.id === (reachabilityEngineId ?? (kind === 'tts' ? 'openai-tts' : 'openai-stt')) && reachable?.remoteConfigured}
					<span class="engine-reachability" class:engine-reachability--ok={reachable.remoteReachable}>
						{reachable.remoteReachable ? '● Endpoint reachable' : '○ Endpoint not reachable'}
					</span>
				{/if}
			</div>
			{#if o.recommended}<span class="badge badge-recommended">Recommended</span>{/if}
		</button>

		{#if selected && config && config.fields.length > 0}
			<div class="engine-config">
				{#each config.fields as field (field.key)}
					<div class="form-field">
						<label class="form-label" for="voice-{kind}-{field.key}">{field.label}</label>
						{#if field.options}
							<select
								id="voice-{kind}-{field.key}"
								class="form-input"
								value={value[field.key] ?? ''}
								onchange={(e) => updateField(field.key, (e.currentTarget as HTMLSelectElement).value)}
							>
								<option value="">— default —</option>
								{#each field.options as opt (opt)}
									<option value={opt}>{opt}</option>
								{/each}
							</select>
						{:else}
							<input
								id="voice-{kind}-{field.key}"
								type={field.key === 'baseURL' ? 'url' : 'text'}
								class="form-input"
								value={value[field.key] ?? ''}
								placeholder={field.placeholder ?? ''}
								autocomplete="off"
								spellcheck={field.key === 'baseURL' ? false : undefined}
								oninput={(e) => updateField(field.key, (e.currentTarget as HTMLInputElement).value)}
							/>
						{/if}
						{#if field.hint}<span class="field-hint">{field.hint}</span>{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/each}
</div>

<style>
	.engine-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.engine-card {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		text-align: left;
		cursor: pointer;
		transition: all var(--transition-fast);
	}
	.engine-card:hover:not(:disabled) {
		border-color: var(--color-border-hover);
		background: var(--color-surface-hover);
	}
	.engine-card--selected {
		/* Selection is shown by the orange border + a 2px ring; the fill stays a
		   neutral surface so translucent status badges (e.g. "Recommended") keep
		   their contrast instead of compositing over an orange tint. */
		border-color: var(--color-primary);
		background: var(--color-surface-hover);
		box-shadow: 0 0 0 1px var(--color-primary);
	}
	.engine-card--disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.engine-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}

	.engine-name {
		font-size: var(--text-sm);
		font-weight: var(--font-medium);
		color: var(--color-text);
	}

	.engine-desc {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.engine-subtitle {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
		font-style: italic;
		margin-top: 2px;
	}

	.engine-reachability {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
		margin-top: 4px;
	}
	.engine-reachability--ok {
		color: var(--color-success, #16a34a);
	}

	.engine-config {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: calc(-1 * var(--space-1)) 0 var(--space-2) var(--space-4);
		padding: var(--space-3) var(--space-4);
		background: var(--color-bg-secondary);
		border-left: 2px solid var(--color-primary);
		border-radius: 0 var(--radius-md) var(--radius-md) 0;
	}

	.field-hint {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
		margin-top: 2px;
	}
</style>
