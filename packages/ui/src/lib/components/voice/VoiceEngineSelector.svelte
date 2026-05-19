<!--
  VoiceEngineSelector — shared TTS/STT picker for the setup wizard and
  the admin Capabilities tab. Renders engine cards; when an engine has
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
	import type { VoiceEngineValue } from '$lib/wizard/types.js';

	let {
		kind,
		value,
		onchange,
	}: {
		kind: 'tts' | 'stt';
		value: VoiceEngineValue;
		onchange: (next: VoiceEngineValue) => void;
	} = $props();

	const options = $derived(kind === 'tts' ? TTS_OPTIONS : STT_OPTIONS);
	const engines = $derived(kind === 'tts' ? TTS_ENGINES : STT_ENGINES);

	function selectEngine(id: string) {
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
		<button
			type="button"
			class="auth-method-card"
			class:auth-method-card--selected={selected}
			onclick={() => selectEngine(o.id)}
		>
			<div class="engine-body">
				<span class="engine-name">{o.name}</span>
				<span class="engine-desc">{o.desc}</span>
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

	.engine-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
		text-align: left;
	}

	.engine-name {
		font-size: var(--text-sm);
		font-weight: var(--font-medium);
		color: var(--color-text);
	}

	.engine-desc {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
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
</style>
