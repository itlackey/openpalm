<!--
  Voice settings panel — simplified 3-engine picker.

  For each of TTS and STT the operator picks one of:
    - OpenPalm Voice — reserved slot, disabled until the addon ships.
    - Remote (OpenAI-compatible) — endpoint URL + optional API key + model.
    - Browser — only shown when the relevant Web Speech API is present.

  Saves to PUT /admin/voice. The route validates the selection (rejects
  `openpalm-voice` and rejects `remote` without a baseURL) and the user-facing
  error surfaces in the banner below.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchVoiceConfig, saveVoiceConfig, type VoiceAddonProfile } from '$lib/api.js';
	import { notifications } from '$lib/notifications.svelte.js';

	interface Props { tokenStored: boolean; }
	let { tokenStored }: Props = $props();

	type EngineId = 'openpalm-voice' | 'remote' | 'browser';

	type VoiceSection = {
		engine: EngineId | '';
		baseURL: string;
		model: string;
		voice: string; // tts only
		language: string; // stt only
	};

	type Availability = {
		stt: { remoteConfigured: boolean; remoteReachable: boolean };
		tts: { remoteConfigured: boolean; remoteReachable: boolean };
	};

	const EMPTY_SECTION = (): VoiceSection => ({ engine: '', baseURL: '', model: '', voice: '', language: '' });

	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);

	let tts = $state<VoiceSection>(EMPTY_SECTION());
	let stt = $state<VoiceSection>(EMPTY_SECTION());
	let availability = $state<Availability>({
		stt: { remoteConfigured: false, remoteReachable: false },
		tts: { remoteConfigured: false, remoteReachable: false },
	});
	let addonProfiles = $state<VoiceAddonProfile[]>([]);
	let selectedProfile = $state<string>('');
	const wantsOpenpalmVoice = $derived(
		tts.engine === 'openpalm-voice' || stt.engine === 'openpalm-voice',
	);

	// Browser Web Speech availability — probed once on mount.
	let browserSttAvailable = $state(false);
	let browserTtsAvailable = $state(false);

	function normalizeEngine(raw: unknown, kind: 'tts' | 'stt'): EngineId | '' {
		if (typeof raw !== 'string') return '';
		if (raw === 'openpalm-voice') return 'openpalm-voice';
		if (raw === 'browser' || raw === (kind === 'tts' ? 'browser-tts' : 'browser-stt')) return 'browser';
		if (!raw || raw.startsWith('skip-')) return '';
		// Anything else (kokoro, openai-tts, whisper-local, openai-stt, …) is treated as remote.
		return 'remote';
	}

	function readSection(raw: Record<string, unknown> | undefined, kind: 'tts' | 'stt'): VoiceSection {
		const s = EMPTY_SECTION();
		if (!raw || typeof raw !== 'object') return s;
		s.engine = normalizeEngine(raw.engine, kind);
		if (typeof raw.baseURL === 'string') s.baseURL = raw.baseURL;
		if (typeof raw.model === 'string') s.model = raw.model;
		if (kind === 'tts' && typeof raw.voice === 'string') s.voice = raw.voice;
		if (kind === 'stt' && typeof raw.language === 'string') s.language = raw.language;
		return s;
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const res = await fetchVoiceConfig();
			tts = readSection(res.tts as Record<string, unknown> | undefined, 'tts');
			stt = readSection(res.stt as Record<string, unknown> | undefined, 'stt');
			const a = (res as { availability?: Availability }).availability;
			if (a) availability = a;
			if (res.addon) {
				addonProfiles = res.addon.profiles ?? [];
				selectedProfile =
					res.addon.selectedProfile ??
					(addonProfiles.find((p) => p.default) ?? addonProfiles[0])?.id ??
					'';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load voice settings.';
		} finally {
			loading = false;
		}
	}

	function buildPayload(section: VoiceSection, kind: 'tts' | 'stt'): Record<string, unknown> | undefined {
		if (!section.engine) return undefined;
		const out: Record<string, unknown> = { enabled: true, engine: section.engine };
		if (section.engine === 'remote') {
			if (section.baseURL) out.baseURL = section.baseURL;
			if (section.model) out.model = section.model;
			if (kind === 'tts' && section.voice) out.voice = section.voice;
			if (kind === 'stt' && section.language) out.language = section.language;
		} else if (section.engine === 'browser' && kind === 'stt' && section.language) {
			out.language = section.language;
		}
		return out;
	}

	async function save(): Promise<void> {
		saving = true;
		error = '';
		saved = false;

		const wantsVoiceAddon =
			tts.engine === 'openpalm-voice' || stt.engine === 'openpalm-voice';

		// Sticky in-progress toast that we update in-place as the route
		// works through its steps. Pre-emptive — even if the addon was
		// already running, the operator gets one beat of feedback so the
		// click feels acknowledged.
		let progressToastId: string | null = null;
		let bumpTimer: ReturnType<typeof setTimeout> | null = null;
		if (wantsVoiceAddon) {
			progressToastId = notifications.push('info', 'Enabling voice addon…', { sticky: true });
			// If the server takes longer than the visible blink of an
			// "Enabling…" message, bump the toast to the "may take a
			// moment" variant so the user doesn't think we're stuck.
			bumpTimer = setTimeout(() => {
				if (progressToastId) {
					notifications.push('info', 'Starting voice addon — this may take a moment…', {
						sticky: true,
						replaceId: progressToastId,
					});
				}
			}, 1500);
		}

		try {
			const result = await saveVoiceConfig({
				tts: buildPayload(tts, 'tts'),
				stt: buildPayload(stt, 'stt'),
				...(wantsOpenpalmVoice && selectedProfile ? { profile: selectedProfile } : {}),
			});

			if (bumpTimer) {
				clearTimeout(bumpTimer);
				bumpTimer = null;
			}

			if (wantsVoiceAddon && progressToastId) {
				const va = result.voiceAddon;
				if (result.ok && va) {
					// Healthy. Replace the sticky "enabling" toast with a
					// friendly success message that auto-dismisses.
					notifications.push(
						'success',
						va.wasAlreadyEnabled
							? "Voice addon ready — let's chat!"
							: "Voice addon started, let's chat!",
						{ replaceId: progressToastId },
					);
				} else if (va) {
					// Server-side flow saw a step fail (compose pull, container
					// start, healthcheck timeout). The error string is already
					// human-readable.
					notifications.push('error', va.error ?? 'Voice addon failed to start.', {
						replaceId: progressToastId,
					});
				} else {
					// 200 but no voiceAddon block — shouldn't happen for an
					// openpalm-voice save, but be defensive.
					notifications.push('success', 'Voice settings saved.', { replaceId: progressToastId });
				}
			}

			saved = true;
			setTimeout(() => { saved = false; }, 3000);
			// Refresh availability after saving — the URL may have changed.
			await load();
		} catch (e) {
			if (bumpTimer) {
				clearTimeout(bumpTimer);
				bumpTimer = null;
			}
			const msg = e instanceof Error ? e.message : 'Failed to save voice settings.';
			error = msg;
			if (progressToastId) {
				notifications.push('error', msg, { replaceId: progressToastId });
			} else if (wantsVoiceAddon) {
				notifications.push('error', msg);
			}
		} finally {
			saving = false;
		}
	}

	onMount(() => {
		// Probe Web Speech APIs (client-only).
		browserSttAvailable = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
		browserTtsAvailable = 'speechSynthesis' in window;
		if (tokenStored) void load();
	});
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
		<p class="section-desc">
			Configure how the assistant listens and speaks. Choose an engine for each;
			the in-app mic uses STT and the optional auto-speak toggle uses TTS.
		</p>

		{#if wantsOpenpalmVoice && addonProfiles.length > 0}
			<section class="engine-section">
				<h3 class="engine-heading">Hardware profile</h3>
				<p class="engine-subheading">Which prebuilt openpalm/voice image runs in the container.</p>
				<div class="form-field">
					<label class="form-label" for="voice-profile">Profile</label>
					<select
						id="voice-profile"
						class="form-input"
						value={selectedProfile}
						onchange={(e) => selectedProfile = (e.currentTarget as HTMLSelectElement).value}
					>
						{#each addonProfiles as profile (profile.id)}
							<option value={profile.id}>
								{profile.label ?? profile.id}{profile.default ? ' (default)' : ''}
							</option>
						{/each}
					</select>
					{#if addonProfiles.find((p) => p.id === selectedProfile)?.requires}
						<span class="field-hint">
							Requires: {addonProfiles.find((p) => p.id === selectedProfile)?.requires}
						</span>
					{/if}
				</div>
			</section>
		{/if}

		<section class="engine-section">
			<h3 class="engine-heading">Text-to-Speech</h3>
			<p class="engine-subheading">How your assistant speaks</p>

			<div class="engine-list">
				{@render engineCard({
					kind: 'tts',
					id: 'openpalm-voice',
					name: 'OpenPalm Voice',
					desc: 'Local Kokoro TTS + Whisper STT bundled together.',
					subtitle: 'Uses the bundled openpalm/voice addon. Enable it in Add-ons first.',
					selected: tts.engine === 'openpalm-voice',
					recommended: true,
				})}
				{@render engineCard({
					kind: 'tts',
					id: 'remote',
					name: 'Remote (OpenAI-compatible)',
					desc: 'Point at any /v1/audio/speech endpoint (OpenAI, Kokoro, Piper, …).',
					selected: tts.engine === 'remote',
					reachable: availability.tts,
				})}
				{#if browserTtsAvailable}
					{@render engineCard({
						kind: 'tts',
						id: 'browser',
						name: 'Browser',
						desc: 'Web Speech API on this device. No setup, voice quality varies.',
						selected: tts.engine === 'browser',
					})}
				{/if}
			</div>

			{#if tts.engine === 'remote'}
				<div class="engine-config">
					<div class="form-field">
						<label class="form-label" for="voice-tts-baseURL">Endpoint URL</label>
						<input
							id="voice-tts-baseURL"
							type="url"
							class="form-input"
							value={tts.baseURL}
							placeholder="http://host.docker.internal:8880/v1"
							autocomplete="off"
							spellcheck={false}
							oninput={(e) => tts.baseURL = (e.currentTarget as HTMLInputElement).value}
						/>
						<span class="field-hint">OpenAI-compatible /v1/audio/speech endpoint.</span>
					</div>
					<div class="form-field">
						<label class="form-label" for="voice-tts-model">Model</label>
						<input
							id="voice-tts-model"
							type="text"
							class="form-input"
							value={tts.model}
							placeholder="tts-1"
							autocomplete="off"
							oninput={(e) => tts.model = (e.currentTarget as HTMLInputElement).value}
						/>
					</div>
					<div class="form-field">
						<label class="form-label" for="voice-tts-voice">Voice</label>
						<input
							id="voice-tts-voice"
							type="text"
							class="form-input"
							value={tts.voice}
							placeholder="alloy"
							autocomplete="off"
							oninput={(e) => tts.voice = (e.currentTarget as HTMLInputElement).value}
						/>
					</div>
				</div>
			{/if}
		</section>

		<section class="engine-section">
			<h3 class="engine-heading">Speech-to-Text</h3>
			<p class="engine-subheading">How your assistant listens</p>

			<div class="engine-list">
				{@render engineCard({
					kind: 'stt',
					id: 'openpalm-voice',
					name: 'OpenPalm Voice',
					desc: 'Local Kokoro TTS + Whisper STT bundled together.',
					subtitle: 'Uses the bundled openpalm/voice addon. Enable it in Add-ons first.',
					selected: stt.engine === 'openpalm-voice',
					recommended: true,
				})}
				{@render engineCard({
					kind: 'stt',
					id: 'remote',
					name: 'Remote (OpenAI-compatible)',
					desc: 'Point at any /v1/audio/transcriptions endpoint (Whisper, …).',
					selected: stt.engine === 'remote',
					reachable: availability.stt,
				})}
				{#if browserSttAvailable}
					{@render engineCard({
						kind: 'stt',
						id: 'browser',
						name: 'Browser',
						desc: 'Web Speech API on this device. Chrome/Edge only on desktop.',
						selected: stt.engine === 'browser',
					})}
				{/if}
			</div>

			{#if stt.engine === 'remote'}
				<div class="engine-config">
					<div class="form-field">
						<label class="form-label" for="voice-stt-baseURL">Endpoint URL</label>
						<input
							id="voice-stt-baseURL"
							type="url"
							class="form-input"
							value={stt.baseURL}
							placeholder="http://host.docker.internal:9000/v1"
							autocomplete="off"
							spellcheck={false}
							oninput={(e) => stt.baseURL = (e.currentTarget as HTMLInputElement).value}
						/>
						<span class="field-hint">OpenAI-compatible /v1/audio/transcriptions endpoint.</span>
					</div>
					<div class="form-field">
						<label class="form-label" for="voice-stt-model">Model</label>
						<input
							id="voice-stt-model"
							type="text"
							class="form-input"
							value={stt.model}
							placeholder="whisper-1"
							autocomplete="off"
							oninput={(e) => stt.model = (e.currentTarget as HTMLInputElement).value}
						/>
					</div>
					<div class="form-field">
						<label class="form-label" for="voice-stt-language">Language</label>
						<input
							id="voice-stt-language"
							type="text"
							class="form-input"
							value={stt.language}
							placeholder="en"
							autocomplete="off"
							oninput={(e) => stt.language = (e.currentTarget as HTMLInputElement).value}
						/>
						<span class="field-hint">A code like <code>en</code> or <code>fr</code>, or leave blank to detect.</span>
					</div>
				</div>
			{:else if stt.engine === 'browser'}
				<div class="engine-config">
					<div class="form-field">
						<label class="form-label" for="voice-stt-browser-language">Language</label>
						<input
							id="voice-stt-browser-language"
							type="text"
							class="form-input"
							value={stt.language}
							placeholder="en-US"
							autocomplete="off"
							oninput={(e) => stt.language = (e.currentTarget as HTMLInputElement).value}
						/>
					</div>
				</div>
			{/if}
		</section>
	</div>
</div>

{#snippet engineCard(opts: {
	kind: 'tts' | 'stt';
	id: EngineId;
	name: string;
	desc: string;
	subtitle?: string;
	selected: boolean;
	disabled?: boolean;
	recommended?: boolean;
	reachable?: { remoteConfigured: boolean; remoteReachable: boolean };
})}
	<button
		type="button"
		class="engine-card"
		class:engine-card--selected={opts.selected}
		class:engine-card--disabled={opts.disabled}
		disabled={opts.disabled}
		onclick={() => {
			if (opts.disabled) return;
			if (opts.kind === 'tts') tts.engine = opts.id;
			else stt.engine = opts.id;
		}}
	>
		<div class="engine-body">
			<span class="engine-name">{opts.name}</span>
			<span class="engine-desc">{opts.desc}</span>
			{#if opts.subtitle}<span class="engine-subtitle">{opts.subtitle}</span>{/if}
			{#if opts.reachable?.remoteConfigured}
				<span class="engine-reachability" class:engine-reachability--ok={opts.reachable.remoteReachable}>
					{opts.reachable.remoteReachable ? '● Endpoint reachable' : '○ Endpoint not reachable'}
				</span>
			{/if}
		</div>
		{#if opts.recommended}<span class="badge badge-recommended">Recommended</span>{/if}
	</button>
{/snippet}

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

	.engine-list { display: flex; flex-direction: column; gap: var(--space-2); }
	.engine-card {
		display: flex; align-items: flex-start; gap: var(--space-3);
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
		border-color: var(--color-primary);
		background: var(--color-primary-subtle);
	}
	.engine-card--disabled {
		opacity: 0.6; cursor: not-allowed;
	}
	.engine-body {
		display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0;
	}
	.engine-name {
		font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text);
	}
	.engine-desc {
		font-size: var(--text-xs); color: var(--color-text-tertiary);
	}
	.engine-subtitle {
		font-size: var(--text-xs); color: var(--color-text-tertiary); font-style: italic; margin-top: 2px;
	}
	.engine-reachability {
		font-size: var(--text-xs); color: var(--color-text-tertiary); margin-top: 4px;
	}
	.engine-reachability--ok { color: var(--color-success, #16a34a); }

	.engine-config {
		display: flex; flex-direction: column; gap: var(--space-3);
		margin: calc(-1 * var(--space-1)) 0 var(--space-2) var(--space-4);
		padding: var(--space-3) var(--space-4);
		background: var(--color-bg-secondary);
		border-left: 2px solid var(--color-primary);
		border-radius: 0 var(--radius-md) var(--radius-md) 0;
	}

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
