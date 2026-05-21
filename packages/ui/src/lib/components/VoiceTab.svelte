<script lang="ts">
	import { onMount } from 'svelte';
	import type { VoiceEngineValue } from '$lib/wizard/types.js';
	import VoiceEngineSelector from './voice/VoiceEngineSelector.svelte';
	import { fetchAssignments, saveAssignments } from '$lib/api.js';

	interface Props { tokenStored: boolean; }
	let { tokenStored }: Props = $props();

	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);

	let tts = $state<VoiceEngineValue>({ engine: '' });
	let stt = $state<VoiceEngineValue>({ engine: '' });

	function readVoiceValue(raw: unknown): VoiceEngineValue {
		if (typeof raw === 'string') return { engine: raw };
		if (raw && typeof raw === 'object') {
			const obj = raw as Record<string, unknown>;
			const hasEngine = typeof obj.engine === 'string';
			const v: VoiceEngineValue = {
				engine: hasEngine ? (obj.engine as string)
					: typeof obj.provider === 'string' ? obj.provider
					: '',
			};
			if (hasEngine && typeof obj.provider === 'string') v.provider = obj.provider;
			if (typeof obj.baseURL === 'string') v.baseURL = obj.baseURL;
			if (typeof obj.model === 'string') v.model = obj.model;
			if (typeof obj.voice === 'string') v.voice = obj.voice;
			if (typeof obj.language === 'string') v.language = obj.language;
			return v;
		}
		return { engine: '' };
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const res = await fetchAssignments();
			const loaded = res.capabilities as Record<string, unknown> | null;
			if (loaded) {
				tts = readVoiceValue(loaded.tts);
				stt = readVoiceValue(loaded.stt);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load voice settings.';
		} finally {
			loading = false;
		}
	}

	async function save(): Promise<void> {
		saving = true;
		error = '';
		saved = false;
		try {
			const voicePayload = (v: VoiceEngineValue): Record<string, unknown> | undefined => {
				if (!v.engine || v.engine.startsWith('skip-')) return undefined;
				const out: Record<string, unknown> = { enabled: true, engine: v.engine };
				if (v.provider) out.provider = v.provider;
				if (v.baseURL) out.baseURL = v.baseURL;
				if (v.model) out.model = v.model;
				if (v.voice) out.voice = v.voice;
				if (v.language) out.language = v.language;
				return out;
			};
			await saveAssignments({ tts: voicePayload(tts), stt: voicePayload(stt) });
			saved = true;
			setTimeout(() => { saved = false; }, 3000);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save voice settings.';
		} finally {
			saving = false;
		}
	}

	onMount(() => { if (tokenStored) void load(); });
</script>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<h2>Voice</h2>
		<div class="panel-header-actions">
			<button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving || !tokenStored}>
				{#if loading}<span class="spinner"></span>{/if}
				Refresh
			</button>
			<button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving || !tokenStored}>
				{#if saving}<span class="spinner"></span>{/if}
				{saved ? 'Saved' : 'Save'}
			</button>
		</div>
	</div>

	{#if error}<div class="error-banner"><span>{error}</span></div>{/if}

	<div class="panel-body">
		<p class="section-desc">Configure the default TTS and STT engines for the assistant's voice channel. These defaults seed the voice channel's web app on first load. Once a user saves their own settings in that app, browser preferences take precedence.</p>

		<section class="engine-section">
			<h3 class="engine-heading">Text-to-Speech</h3>
			<p class="engine-subheading">How your assistant speaks</p>
			<VoiceEngineSelector kind="tts" value={tts} onchange={(v) => tts = v} />
		</section>

		<section class="engine-section">
			<h3 class="engine-heading">Speech-to-Text</h3>
			<p class="engine-subheading">How your assistant listens</p>
			<VoiceEngineSelector kind="stt" value={stt} onchange={(v) => stt = v} />
		</section>
	</div>
</div>

<style>
	.panel-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-6);
	}
	.panel-header h2 { font-size: var(--text-lg); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.panel-header-actions { display: flex; gap: var(--space-2); }
	.panel-body { display: flex; flex-direction: column; gap: var(--space-6); }
	.section-desc { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; }
	.engine-section { display: flex; flex-direction: column; gap: var(--space-3); }
	.engine-heading { font-size: var(--text-sm); font-weight: var(--font-semibold); text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text); margin: 0; }
	.engine-subheading { font-size: var(--text-xs); color: var(--color-text-secondary); margin: 0; }
	.error-banner {
		display: flex; align-items: center; gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: var(--color-error-bg, rgba(220, 38, 38, 0.08));
		border: 1px solid var(--color-error-border, rgba(220, 38, 38, 0.25));
		border-radius: var(--radius-md); font-size: var(--text-sm);
		color: var(--color-error, #dc2626); margin-bottom: var(--space-4);
	}
	.spinner { display: inline-block; width: 0.75rem; height: 0.75rem; border: 2px solid transparent; border-top-color: currentColor; border-radius: 50%; animation: spin 0.6s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
