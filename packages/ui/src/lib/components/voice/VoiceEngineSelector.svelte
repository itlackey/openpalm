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
	} from '$lib/client/constants.js';
	import type {
		SttOption,
		TtsOption,
		VoiceEngineConfig,
		VoiceEngineValue,
	} from '$lib/client/types.js';

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
		// Drop fields that aren't supported by this engine to keep the config clean
		const allowed = new Set(config?.fields.map((f) => f.key));
		const next: VoiceEngineValue = {
			engine: id,
			provider: config?.provider,
			...(allowed.has('baseURL') && value.baseURL ? { baseURL: value.baseURL } : {}),
			...(allowed.has('model') && value.model ? { model: value.model } : {}),
			...(allowed.has('voice') && value.voice ? { voice: value.voice } : {}),
			...(allowed.has('language') && value.language ? { language: value.language } : {}),
			...(allowed.has('apiKey') && value.apiKey ? { apiKey: value.apiKey } : {}),
		};
		onchange(next);
	}

	function updateField(key: 'baseURL' | 'model' | 'voice' | 'language' | 'apiKey', val: string) {
		const next: VoiceEngineValue = { ...value };
		if (val) next[key] = val;
		else delete next[key];
		onchange(next);
	}
</script>

<!-- Engine choice is single-select: radio semantics expose the selected
     state programmatically (WCAG 4.1.2) — the CSS tint alone is silent to AT. -->
<div class="engine-list" role="radiogroup" aria-label="{kind === 'tts' ? 'Text-to-speech' : 'Speech-to-text'} engine">
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
			role="radio"
			aria-checked={selected}
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
								type={field.key === 'baseURL' ? 'url' : field.key === 'apiKey' ? 'password' : 'text'}
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
		gap: 0;
	}

	.engine-card {
		display: flex;
		align-items: flex-start;
		gap: var(--s-sp-3);
		padding: var(--s-sp-3) var(--s-sp-4);
		background: none;
		border: var(--s-hair) solid var(--s-line-soft);
		border-top: none;
		border-radius: 0;
		text-align: left;
		cursor: pointer;
		appearance: none;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		width: 100%;
	}
	.engine-card:first-child {
		border-top: var(--s-hair) solid var(--s-line-soft);
	}
	.engine-card:hover:not(:disabled) {
		background: var(--s-paper-deep);
	}
	.engine-card--selected {
		border-left: 2px solid var(--s-seal);
		color: var(--s-seal);
		background: none;
	}
	.engine-card--disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.engine-body {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-1);
		flex: 1;
		min-width: 0;
	}

	.engine-name {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: var(--s-track-label);
		color: inherit;
	}

	.engine-desc {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-2);
		text-transform: none;
		letter-spacing: 0;
	}

	.engine-subtitle {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		text-transform: none;
		letter-spacing: 0;
		margin-top: var(--s-sp-1);
	}

	.engine-reachability {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		text-transform: none;
		letter-spacing: 0;
		margin-top: var(--s-sp-1);
	}
	.engine-reachability--ok {
		color: var(--s-moss);
	}

	.engine-config {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-3);
		margin: 0 0 0 var(--s-sp-4);
		padding: var(--s-sp-3) var(--s-sp-4);
		background: none;
		border-left: 2px solid var(--s-seal);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
	}

	.field-hint {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		margin-top: var(--s-sp-1);
		text-transform: none;
		letter-spacing: 0;
	}

	/* Stillness overrides for global form utilities used inside this component */
	:global(.engine-config .form-field) {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-1);
	}
	:global(.engine-config .form-label) {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: var(--s-track-label);
		color: var(--s-ink-3);
	}
	:global(.engine-config .form-input) {
		width: 100%;
		height: auto;
		border: none;
		border-bottom: var(--s-hair) solid var(--s-line);
		border-radius: 0;
		padding: 0.5rem 0;
		background: none;
		color: var(--s-ink);
		font-family: var(--s-font-display);
		font-size: var(--s-type-whisper);
		box-shadow: none;
	}
	:global(.engine-config .form-input:focus) {
		outline: none;
		border-bottom-color: var(--s-seal);
		box-shadow: none;
	}
	:global(.engine-config .form-input:focus-visible) {
		outline: none;
		border-bottom-color: var(--s-seal);
	}
	:global(.engine-card .badge) {
		display: inline-flex;
		align-items: center;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: var(--s-track-label);
		padding: 0.15em 0.5em;
		border-radius: 2px;
		white-space: nowrap;
		background: none;
		border: var(--s-hair) solid var(--s-moss);
		color: var(--s-moss);
	}
</style>
