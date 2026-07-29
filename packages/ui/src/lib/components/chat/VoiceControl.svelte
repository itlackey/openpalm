<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import IconMic from '$lib/components/icons/IconMic.svelte';
	import IconSoundOff from '$lib/components/icons/IconSoundOff.svelte';
	import IconSoundOn from '$lib/components/icons/IconSoundOn.svelte';
	import IconStop from '$lib/components/icons/IconStop.svelte';
	import IconWaves from '$lib/components/icons/IconWaves.svelte';
	import { chat } from '$lib/chat/chat-state.svelte.js';
	import {
		destroyVoice,
		initVoice,
		setTtsAutoEnabled,
		startConversation,
		startListening,
		stopConversation,
		stopListening,
		stopSpeaking,
		voiceState
	} from '$lib/voice/voice-state.svelte.js';

	type Props = {
		draft?: string;
		dictationMode?: 'draft' | 'send';
	};

	let { draft = $bindable(''), dictationMode = 'send' }: Props = $props();

	type OpenPalmBridge = {
		setTrayMicRecording?: (recording: boolean) => Promise<void>;
		onGlobalMicToggle?: (callback: () => void) => (() => void) | void;
		requestMicPermission?: () => Promise<string>;
	};

	let mounted = $state(false);
	let microphoneRequestPending = $state(false);
	let removeGlobalMicToggle: (() => void) | null = null;
	const pathname = $derived(page.url?.pathname ?? '');
	const chatSurface = $derived(
		pathname === '/chat' ||
			pathname.startsWith('/chat/') ||
			pathname === '/advanced' ||
			pathname.startsWith('/advanced/')
	);
	const voiceActive = $derived(
		!voiceState.conversationActive && voiceState.status === 'recording'
	);
	const dictationTranscribing = $derived(
		!voiceState.conversationActive && voiceState.status === 'transcribing'
	);
	const voiceEnabled = $derived(
		mounted &&
			chatSurface &&
			voiceState.sttEngine !== 'disabled' &&
			voiceState.sttSupported
	);
	const ttsEnabled = $derived(
		mounted && voiceState.ttsEngine !== 'disabled' && voiceState.ttsSupported
	);
	const sendBlocked = $derived(dictationMode === 'send' && chat.sending);

	onMount(() => {
		let active = true;
		void initVoice().then(() => {
			if (active) mounted = true;
		});

		const openpalm = (window as Window & { openpalm?: OpenPalmBridge }).openpalm;
		removeGlobalMicToggle =
			openpalm?.onGlobalMicToggle?.(() => {
				void toggleDictation();
			}) ?? null;

		return () => {
			active = false;
			mounted = false;
			void openpalm?.setTrayMicRecording?.(false);
			removeGlobalMicToggle?.();
			removeGlobalMicToggle = null;
			destroyVoice();
		};
	});

	async function prepareMicrophoneAccess(): Promise<boolean> {
		if (microphoneRequestPending) return false;
		microphoneRequestPending = true;
		const openpalm = (window as Window & { openpalm?: OpenPalmBridge }).openpalm;
		try {
			const status = await openpalm?.requestMicPermission?.();
			if (!mounted || !chatSurface) return false;
			if (status === 'denied-no-prompt') {
				voiceState.errorMessage =
					'This OpenPalm build cannot request microphone access on macOS. Please update to the latest version of the desktop app.';
				return false;
			}
			if (status === 'denied' || status === 'restricted') {
				voiceState.errorMessage =
					'Microphone access is turned off. In the System Settings window that just opened, enable OpenPalm under Microphone, then quit and reopen the app.';
				return false;
			}
			return true;
		} finally {
			microphoneRequestPending = false;
		}
	}

	async function toggleDictation(): Promise<void> {
		if (!chatSurface) return;
		if (voiceActive) {
			stopListening();
			void (window as Window & { openpalm?: OpenPalmBridge }).openpalm?.setTrayMicRecording?.(
				false
			);
			return;
		}
		if (!voiceEnabled || sendBlocked || dictationTranscribing || microphoneRequestPending) return;
		if (!(await prepareMicrophoneAccess())) return;

		stopSpeaking();
		const openpalm = (window as Window & { openpalm?: OpenPalmBridge }).openpalm;
		void openpalm?.setTrayMicRecording?.(true);
		startListening(
			(transcript) => {
				if (!mounted || !chatSurface) return;
				const trimmed = transcript.trim();
				if (!trimmed) return;
				if (dictationMode === 'draft') {
					draft = draft.trim().length > 0 ? `${draft.trimEnd()} ${trimmed}` : trimmed;
					return;
				}
				void chat.send(trimmed);
			},
			() => void openpalm?.setTrayMicRecording?.(false)
		);
	}

	async function toggleConversation(): Promise<void> {
		if (!chatSurface) return;
		if (voiceState.conversationActive) {
			stopConversation();
			return;
		}
		if (!voiceEnabled || microphoneRequestPending) return;
		if (!(await prepareMicrophoneAccess())) return;
		startConversation((transcript) => {
			if (mounted && chatSurface) void chat.sendUtterance(transcript);
		});
	}

	function toggleSpokenResponses(): void {
		setTtsAutoEnabled(!voiceState.ttsAutoEnabled);
	}
</script>

<div class="voice-control" role="toolbar" aria-label="Voice controls">
	<button
		class="voice-btn"
		class:active={voiceState.ttsAutoEnabled}
		type="button"
		aria-label={voiceState.ttsAutoEnabled
			? 'Turn off spoken responses'
			: 'Turn on spoken responses'}
		title={voiceState.ttsAutoEnabled ? 'Spoken responses are on' : 'Spoken responses are off'}
		aria-pressed={voiceState.ttsAutoEnabled}
		disabled={!ttsEnabled}
		onclick={toggleSpokenResponses}
	>
		{#if voiceState.ttsAutoEnabled}
			<IconSoundOn size={18} />
		{:else}
			<IconSoundOff size={18} />
		{/if}
	</button>
	<button
		class="voice-btn"
		class:active={voiceState.conversationActive}
		type="button"
		aria-label={voiceState.conversationActive
			? 'Stop conversation mode'
			: 'Start conversation mode'}
		title={voiceState.conversationActive
			? 'Stop hands-free conversation'
			: 'Start hands-free conversation'}
		aria-pressed={voiceState.conversationActive}
		disabled={!voiceEnabled || !ttsEnabled || microphoneRequestPending}
		onclick={toggleConversation}
	>
		<IconWaves size={19} />
	</button>
	<button
		class="voice-btn dictate-btn"
		class:active={voiceActive}
		class:transcribing={dictationTranscribing}
		type="button"
		aria-label={!chatSurface
			? 'Voice input unavailable outside chat'
			: dictationTranscribing
				? 'Transcribing message'
				: voiceActive
					? 'Stop dictation'
					: 'Dictate message'}
		title={!chatSurface
			? 'Voice input unavailable outside chat'
			: dictationTranscribing
				? 'Transcribing message'
				: voiceActive
					? 'Stop dictation'
					: 'Dictate message'}
		aria-pressed={voiceActive}
		disabled={!voiceEnabled || sendBlocked || dictationTranscribing || microphoneRequestPending}
		onclick={toggleDictation}
	>
		{#if voiceActive}
			<IconStop size={17} />
		{:else}
			<IconMic size={19} />
		{/if}
	</button>
</div>

<style>
	.voice-control {
		display: flex;
		align-items: center;
		gap: var(--s-sp-1);
	}

	.voice-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var(--s-paper);
		color: var(--s-ink-3);
		cursor: pointer;
		flex-shrink: 0;
	}

	.voice-btn:hover,
	.voice-btn.active {
		color: var(--s-seal);
	}

	.voice-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.voice-btn:focus-visible {
		outline: 2px solid var(--s-seal);
		outline-offset: 1px;
	}
</style>
