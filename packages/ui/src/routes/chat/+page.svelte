<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
	import ChatInput from '$lib/components/chat/ChatInput.svelte';
	import SessionList from '$lib/components/chat/SessionList.svelte';
	import Presence from '$lib/components/chat/Presence.svelte';
	import { isLocalAssistantUrl } from '$lib/assistant-endpoint.js';
	import { probeChatBackend } from '$lib/api.js';
	import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
	import { buildAdvancedPath } from '$lib/chat/navigation.js';
	import { chat } from '$lib/chat/chat-state.svelte.js';
	import { endpointsService } from '$lib/endpoints-state.svelte.js';
	import { themeService } from '$lib/theme-state.svelte.js';
	import {
		voiceState,
		setTtsAutoEnabled,
		startListening,
		stopListening,
		initVoice
	} from '$lib/voice/voice-state.svelte.js';
	import IconSoundOn from '$lib/components/icons/IconSoundOn.svelte';
	import IconSoundOff from '$lib/components/icons/IconSoundOff.svelte';
	import IconConversations from '$lib/components/icons/IconConversations.svelte';
	import IconClose from '$lib/components/icons/IconClose.svelte';
	import IconThemeSystem from '$lib/components/icons/IconThemeSystem.svelte';
	import IconThemeLight from '$lib/components/icons/IconThemeLight.svelte';
	import IconThemeDark from '$lib/components/icons/IconThemeDark.svelte';
	import IconAdvanced from '$lib/components/icons/IconAdvanced.svelte';

	let scrollAnchorEl = $state<HTMLDivElement | undefined>();

	const entriesLoading = $derived(chat.entriesLoading);
	const sessionsLoading = $derived(
		chat.byEndpoint.get(chat.activeEndpointId)?.sessionsLoading ?? false
	);

	// ── Garden (session veil) ──────────────────────────────────────────
	let gardenOpen = $state(false);

	function openGarden(): void {
		gardenOpen = true;
	}
	function closeGarden(): void {
		gardenOpen = false;
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	async function reconnect(): Promise<void> {
		chat.error = '';
		// onEndpointChanged always calls loadSessions() internally — no separate call needed.
		await chat.onEndpointChanged(endpointsService.activeId);
	}

	async function handleSend(text: string): Promise<void> {
		await chat.send(text);
	}

	let permissionActionInFlight = $state<'once' | 'always' | 'reject' | null>(null);

	async function handlePermissionReply(reply: 'once' | 'always' | 'reject'): Promise<void> {
		permissionActionInFlight = reply;
		try {
			await chat.answerPermission(reply);
		} finally {
			permissionActionInFlight = null;
		}
	}

	async function handleQuestionOption(answer: string): Promise<void> {
		await chat.answerQuestion(answer);
	}

	function handleQuestionDraft(index: number, event: Event): void {
		chat.setQuestionAnswer(index, (event.currentTarget as HTMLInputElement).value);
	}

	async function handleQuestionSubmit(): Promise<void> {
		await chat.answerQuestion();
	}

	async function handleQuestionReject(): Promise<void> {
		await chat.rejectQuestion();
	}

	// MutationObserver-based autoscroll: fires whenever the thread DOM changes
	// (new message, streaming text, loading spinners, permission cards, etc.)
	// — no $effect or afterUpdate needed.
	function autoscroll(node: HTMLElement): { destroy(): void } {
		const observer = new MutationObserver(() => {
			queueMicrotask(() => scrollAnchorEl?.scrollIntoView({ behavior: 'smooth' }));
		});
		observer.observe(node, { childList: true, subtree: true, characterData: true });
		return { destroy() { observer.disconnect(); } };
	}

	function clamp(text: string, max = 160): string {
		return text.length > max ? `${text.slice(0, max - 1)}…` : text;
	}


	// ── Voice / TTS ───────────────────────────────────────────────────────

	const voiceActive = $derived(
		voiceState.status === 'recording' || voiceState.status === 'transcribing'
	);
	const ttsEnabled = $derived(voiceState.ttsAutoEnabled);
	const voiceEnabled = $derived(voiceState.sttEngine !== 'disabled' && voiceState.sttSupported);
	const ttsAvailable = $derived(voiceState.ttsSupported);

	function toggleVoice(): void {
		if (voiceActive) {
			stopListening();
		} else {
			startListening((transcript) => {
				void chat.send(transcript);
			});
		}
	}

	function toggleSpeak(): void {
		setTtsAutoEnabled(!voiceState.ttsAutoEnabled);
	}

	// ── New session ────────────────────────────────────────────────────────

	async function beginNew(): Promise<void> {
		await chat.startNewSession();
		await goto('/chat', { replaceState: true });
		closeGarden();
	}

	// ── Endpoint switching ──────────────────────────────────────────────────

	let endpointSwitching = $state(false);

	async function activateEndpoint(id: string): Promise<void> {
		if (endpointSwitching) return;
		if (id === endpointsService.active?.id) {
			closeGarden();
			return;
		}
		endpointSwitching = true;
		try {
			await endpointsService.activate(id);
			closeGarden();
		} catch {
			/* error surfaced via endpointsService.error */
		} finally {
			endpointSwitching = false;
		}
	}

	// ── Mount ─────────────────────────────────────────────────────────────
	onMount(() => {
		document.documentElement.classList.add('chat-locked');
		document.body.classList.add('chat-locked', 'stillness-mode');

		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') closeGarden();
		}
		document.addEventListener('keydown', onKey);

		let visDestroyed = false;
		function handleVisibilityChange(): void {
			if (visDestroyed || document.visibilityState !== 'visible') return;
			void (async () => {
				const reachable = await probeChatBackend();
				if (!reachable && !visDestroyed) {
					chat.error = 'Assistant is not reachable. Try reconnecting.';
				} else if (!visDestroyed) {
					await chat.loadSessions();
				}
			})();
		}
		document.addEventListener('visibilitychange', handleVisibilityChange);

		void initVoice();

		void (async () => {
			try {
				advancedModeService.init();
				const requestedSessionId = page.url.searchParams.get('session');
				if (advancedModeService.enabled) {
					await goto(buildAdvancedPath(requestedSessionId), { replaceState: true });
					return;
				}
				await endpointsService.load();
				await chat.onEndpointChanged(endpointsService.activeId);
				if (requestedSessionId) {
					await chat.openSession(requestedSessionId);
				}
				if (page.url.searchParams.get('new') === '1') {
					await chat.startNewSession();
					await goto('/chat', { replaceState: true });
				}
			} catch {
				chat.error = 'Unable to reach the assistant.';
			}
		})();

		return () => {
			visDestroyed = true;
			document.documentElement.classList.remove('chat-locked');
			document.body.classList.remove('chat-locked', 'stillness-mode');
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});
</script>

<svelte:head>
	<title>{endpointsService.active?.label ?? 'OpenPalm'}</title>
</svelte:head>

<!-- atmosphere -->
<div class="s-field"></div>
<div class="s-moon"></div>
<div class="s-grain"></div>

<!-- corners: the only persistent chrome -->
<!-- top-left: presence / logo -->
<div class="s-corner s-corner-left">
	<Presence
		height={32}
		{voiceEnabled}
		sending={chat.sending}
		voiceStatus={voiceState.status}
		onToggle={toggleVoice}
	/>
</div>

<!-- top-right: advanced -->
<div class="s-corner s-corner-right">
	<div class="s-glyph-cell">
		<button
			class="s-glyph-btn"
			type="button"
			aria-label="Advanced mode"
			aria-pressed={advancedModeService.enabled}
			onclick={() => {
				advancedModeService.setEnabled(true);
				void goto(buildAdvancedPath(page.url.searchParams.get('session') ?? chat.activeSessionId));
			}}
		>
			<IconAdvanced size={20} />
		</button>
		<span class="s-glyph-label">advanced</span>
	</div>
</div>

<!-- bottom-left: voice (conditional) + theme toggle -->
<div class="s-corner s-corner-bottom-left">
	{#if ttsAvailable && voiceEnabled}
		<div class="s-glyph-cell">
			<span class="s-glyph-label">voice</span>
			<button
				class="s-glyph-btn"
				type="button"
				aria-label={ttsEnabled ? 'Turn off spoken responses' : 'Turn on spoken responses'}
				aria-pressed={ttsEnabled}
				onclick={toggleSpeak}
			>
				{#if ttsEnabled}
					<IconSoundOn size={20} />
				{:else}
					<IconSoundOff size={20} />
				{/if}
			</button>
		</div>
	{/if}
	<div class="s-glyph-cell">
		<span class="s-glyph-label">theme</span>
		<button
			class="s-glyph-btn s-orb-btn"
			type="button"
			onclick={() => themeService.toggle()}
			aria-label={themeService.preference === 'system'
				? 'Switch to light theme'
				: themeService.preference === 'light'
					? 'Switch to dark theme'
					: 'Switch to system theme'}
		>
			{#if themeService.preference === 'light'}
				<IconThemeLight size={20} />
			{:else if themeService.preference === 'dark'}
				<IconThemeDark size={20} />
			{:else}
				<IconThemeSystem size={20} />
			{/if}
		</button>
	</div>
</div>

<!-- bottom-right: conversations / close (toggles when veil is open) -->
<div class="s-corner s-corner-bottom-right">
	<div class="s-glyph-cell">
		<span class="s-glyph-label">{gardenOpen ? 'close' : 'conversations'}</span>
		<button
			class="s-glyph-btn"
			type="button"
			onclick={gardenOpen ? closeGarden : openGarden}
			aria-label={gardenOpen ? 'Return to the conversation' : 'Conversations'}
		>
			{#if gardenOpen}
				<IconClose size={20} />
			{:else}
				<IconConversations size={22} />
			{/if}
		</button>
	</div>
</div>

<!-- conversation thread -->
<main class="s-scroll" id="s-scroll" aria-label="Chat history">
	<div class="s-thread" id="s-thread" use:autoscroll>
		{#if sessionsLoading || entriesLoading}
			<div class="s-loading" aria-live="polite">
				<span class="s-loading-text">loading…</span>
			</div>
		{/if}

		{#each chat.entries as entry (entry.id)}
			<ChatMessage {entry} />
		{/each}

		{#if chat.sending}
			<div class="s-pending" aria-live="polite">
				{#if chat.pendingAssistantText}
					<div class="turn master">
						<div class="master-words settled s-streaming">
							<p>{chat.pendingAssistantText}</p>
						</div>
					</div>
				{:else if !chat.pendingPermission && !chat.pendingQuestion}
					<div class="s-thinking">
						<span class="s-thinking-text">thinking…</span>
					</div>
				{/if}

				{#if chat.pendingToolStates.length > 0}
					<div class="s-live-deeds">
						<div class="deeds-inner">
							{#each chat.pendingToolStates as tool}
								<div class="deed">{tool.title || tool.tool || 'step'}</div>
							{/each}
						</div>
					</div>
				{/if}

				{#if chat.pendingPermission}
					<div class="s-action-card" role="group" aria-label="Permission request">
						<div class="s-action-kicker">permission request</div>
						<div class="s-action-title">{chat.pendingPermission.permission}</div>
						{#if chat.pendingPermission.detail}
							<p class="s-action-body">{clamp(chat.pendingPermission.detail)}</p>
						{/if}
						{#if chat.pendingPermission.patterns.length > 0}
							<code class="s-action-code">{chat.pendingPermission.patterns.join(', ')}</code>
						{/if}
						{#if chat.pendingPermission.always.length > 0}
							<code class="s-action-code">{chat.pendingPermission.always.join(', ')}</code>
						{/if}
						{#if chat.pendingPermission.message}
							<p class="s-action-body">{chat.pendingPermission.message}</p>
						{/if}
						<div class="s-action-btns">
							<button
								class="s-action-btn s-action-btn-primary"
								type="button"
								onclick={() => void handlePermissionReply('once')}
								disabled={chat.pendingPermission.status === 'submitting' ||
									chat.pendingPermission.status === 'resolved'}
							>
								{permissionActionInFlight === 'once' ? 'sending…' : 'allow this once'}
							</button>
							<button
								class="s-action-btn"
								type="button"
								onclick={() => void handlePermissionReply('always')}
								disabled={chat.pendingPermission.status === 'submitting' ||
									chat.pendingPermission.status === 'resolved'}
							>
								{permissionActionInFlight === 'always' ? 'sending…' : 'always allow'}
							</button>
							<button
								class="s-action-btn s-action-btn-danger"
								type="button"
								onclick={() => void handlePermissionReply('reject')}
								disabled={chat.pendingPermission.status === 'submitting' ||
									chat.pendingPermission.status === 'resolved'}
							>
								{permissionActionInFlight === 'reject' ? 'sending…' : 'deny'}
							</button>
						</div>
					</div>
				{/if}

				{#if chat.pendingQuestion}
					<div class="s-action-card" role="group" aria-label="Assistant question">
						<div class="s-action-kicker">a question for you</div>
						{#if chat.pendingQuestion.questions.length === 1 && chat.pendingQuestion.questions[0]}
							<p class="s-action-question">{chat.pendingQuestion.questions[0].question}</p>
							{#if chat.pendingQuestion.questions[0].options.length > 0}
								<div class="s-action-options">
									{#each chat.pendingQuestion.questions[0].options as option, index (`${chat.pendingQuestion.requestID}:${index}`)}
										<button
											class="s-action-btn"
											type="button"
											onclick={() => void handleQuestionOption(option.label)}
											disabled={chat.pendingQuestion.status === 'submitting' ||
												chat.pendingQuestion.status === 'answered' ||
												chat.pendingQuestion.status === 'rejected'}
										>
											{option.label}
										</button>
									{/each}
								</div>
							{/if}
							<p class="s-action-hint">or write your answer below</p>
						{:else}
							<div class="s-multi-questions">
								{#each chat.pendingQuestion.questions as question, index (`${chat.pendingQuestion.requestID}:question:${index}`)}
									<div class="s-question-item">
										{#if question.header}
											<div class="s-action-kicker">{question.header}</div>
										{/if}
										<p class="s-action-question">{question.question}</p>
										{#if question.options.length > 0}
											<div class="s-action-options">
												{#each question.options as option, optionIndex (`${chat.pendingQuestion.requestID}:${index}:${optionIndex}`)}
													<button
														class="s-action-btn"
														class:selected={chat.pendingQuestion.answers[index] === option.label}
														type="button"
														onclick={() => chat.setQuestionAnswer(index, option.label)}
														disabled={chat.pendingQuestion.status === 'submitting' ||
															chat.pendingQuestion.status === 'answered' ||
															chat.pendingQuestion.status === 'rejected'}
													>
														{option.label}
													</button>
												{/each}
											</div>
										{/if}
										<input
											class="s-question-input"
											type="text"
											value={chat.pendingQuestion.answers[index]}
											placeholder="Type an answer"
											oninput={(event) => handleQuestionDraft(index, event)}
											disabled={chat.pendingQuestion.status === 'submitting' ||
												chat.pendingQuestion.status === 'answered' ||
												chat.pendingQuestion.status === 'rejected'}
										/>
									</div>
								{/each}
							</div>
							<div class="s-action-btns">
								<button
									class="s-action-btn s-action-btn-primary"
									type="button"
									onclick={() => void handleQuestionSubmit()}
									disabled={chat.pendingQuestion.status === 'submitting' ||
										chat.pendingQuestion.status === 'answered' ||
										chat.pendingQuestion.status === 'rejected'}
								>
									submit answers
								</button>
								<button
									class="s-action-btn"
									type="button"
									onclick={() => void handleQuestionReject()}
									disabled={chat.pendingQuestion.status === 'submitting' ||
										chat.pendingQuestion.status === 'answered' ||
										chat.pendingQuestion.status === 'rejected'}
								>
									can't answer
								</button>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		<div bind:this={scrollAnchorEl} aria-hidden="true" style="height:1px"></div>
	</div>
</main>

<!-- error banner -->
{#if chat.error}
	<div class="s-error-banner" role="alert">
		<span class="s-error-msg">{chat.error}</span>
		<button class="s-error-reconnect" type="button" onclick={reconnect}>reconnect</button>
		<button
			class="s-error-dismiss"
			type="button"
			aria-label="Dismiss"
			onclick={() => {
				chat.error = '';
			}}>×</button
		>
	</div>
{/if}

<!-- composer -->
<div class="s-base">
	<ChatInput
		sending={chat.sending}
		questionPending={!!chat.pendingQuestion && chat.pendingQuestion.questions.length === 1}
		onSend={handleSend}
		{voiceEnabled}
		{voiceActive}
		onMicToggle={toggleVoice}
	/>
</div>

<!-- garden veil -->
<div
	class="s-veil"
	class:open={gardenOpen}
	inert={!gardenOpen}
	aria-hidden={!gardenOpen}
	role="dialog"
	aria-label="Conversations and assistant"
>
	<div class="s-veil-head">
		<div>
			<div class="s-veil-title">Conversations</div>
			{#if endpointsService.active}
				<div class="s-veil-sub">{endpointsService.active.label}</div>
			{/if}
		</div>
	</div>

	<div class="s-veil-body">
		<section class="s-veil-section">
			<div class="s-section-head">
				<div class="s-veil-section-label">assistant</div>
				<a class="s-new-convo" href="/admin/endpoints" onclick={closeGarden}>
					<span class="s-new-mark" aria-hidden="true">
						<svg width="11" height="11" viewBox="0 0 12 12" fill="none">
							<circle cx="6" cy="6" r="2.4" stroke="currentColor" stroke-width="1.1" />
							<line
								x1="4.5"
								y1="3.6"
								x2="4.5"
								y2="1.5"
								stroke="currentColor"
								stroke-width="1.1"
								stroke-linecap="round"
							/>
							<line
								x1="7.5"
								y1="3.6"
								x2="7.5"
								y2="1.5"
								stroke="currentColor"
								stroke-width="1.1"
								stroke-linecap="round"
							/>
							<line
								x1="6"
								y1="8.4"
								x2="6"
								y2="10.5"
								stroke="currentColor"
								stroke-width="1.1"
								stroke-linecap="round"
							/>
						</svg>
					</span>
					manage connections
				</a>
			</div>
			<div class="s-endpoint-list" role="group" aria-label="Assistant endpoints">
				{#each endpointsService.endpoints as ep (ep.id)}
					<div class="s-endpoint-item">
						<button
							type="button"
							class="s-endpoint"
							class:active={ep.id === endpointsService.active?.id}
							aria-current={ep.id === endpointsService.active?.id ? 'true' : undefined}
							onclick={() => void activateEndpoint(ep.id)}
							disabled={endpointSwitching}
						>
							<div class="s-endpoint-label">{ep.label}</div>
							<div class="s-endpoint-url">{ep.url}</div>
						</button>
						{#if ep.url && isLocalAssistantUrl(ep.url)}
							<a class="s-endpoint-manage" href="/admin" onclick={closeGarden}
								>manage this assistant</a
							>
						{/if}
					</div>
				{/each}
			</div>
		</section>

		<section class="s-veil-section">
			<div class="s-section-head">
				<div class="s-veil-section-label">conversations</div>
				<button class="s-new-convo" type="button" onclick={() => void beginNew()}>
					<span class="s-new-mark" aria-hidden="true">+</span> begin anew
				</button>
			</div>
			<SessionList onChosen={closeGarden} hideNewBtn={true} />
		</section>
	</div>
</div>

<style>
	/* Hide the global navbar on the Stillness chat page */
	:global(body.stillness-mode .navbar) {
		display: none !important;
	}

	/* ── Atmosphere ───────────────────────────────────────────────────── */

	.s-field {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		background: radial-gradient(120% 80% at 50% 14%, transparent 38%, var(--s-paper-deep) 100%);
		transition: background var(--s-t-theme) var(--s-ease);
	}

	.s-moon {
		position: fixed;
		z-index: 0;
		pointer-events: none;
		top: -7vmin;
		right: -7vmin;
		width: 46vmin;
		height: 46vmin;
		border-radius: 50%;
		opacity: 0;
		transition: opacity 1.4s var(--s-ease);
	}

	:global([data-theme='dark']) .s-moon,
	:global([data-theme='night']) .s-moon {
		opacity: 1;
		background: radial-gradient(
			circle at 38% 38%,
			rgba(218, 214, 201, 0.1),
			rgba(218, 214, 201, 0.02) 55%,
			transparent 70%
		);
	}

	.s-grain {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		opacity: var(--s-paper-grain);
		mix-blend-mode: soft-light;
		background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNjAnIGhlaWdodD0nMTYwJz48ZmlsdGVyIGlkPSduJz48ZmVUdXJidWxlbmNlIHR5cGU9J2ZyYWN0YWxOb2lzZScgYmFzZUZyZXF1ZW5jeT0nMC45JyBudW1PY3RhdmVzPScyJyBzdGl0Y2hUaWxlcz0nc3RpdGNoJy8+PC9maWx0ZXI+PHJlY3Qgd2lkdGg9JzEwMCUnIGhlaWdodD0nMTAwJScgZmlsdGVyPSd1cmwoI24pJy8+PC9zdmc+');
	}

	/* ── Corners ──────────────────────────────────────────────────────── */

	.s-corner {
		position: fixed;
		z-index: 70;
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		padding: var(--s-chrome-pad);
	}

	.s-corner-left {
		top: 0;
		left: 0;
		align-items: flex-start;
	}
	.s-corner-right {
		top: 0;
		right: 0;
		align-items: flex-start;
	}
	.s-corner-bottom-left {
		bottom: 0;
		left: 0;
	}
	.s-corner-bottom-right {
		bottom: 0;
		right: 0;
	}

	/* Each icon + its label stacked vertically */
	.s-glyph-cell {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
	}
	.s-corner-bottom-right .s-glyph-cell {
		align-items: flex-end;
	}
	.s-glyph-btn {
		appearance: none;
		border: 0;
		background: none;
		cursor: pointer;
		color: var(--s-ink-2);
		padding: 0.4rem;
		margin: -0.4rem;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		transition:
			color var(--s-t-quick) var(--s-ease),
			transform 0.6s var(--s-ease);
	}

	.s-glyph-btn:hover {
		color: var(--s-ink);
	}
	.s-glyph-btn:active {
		transform: scale(0.94);
	}
	.s-glyph-btn :global(.s-icon) {
		display: block;
	}

	.s-glyph-btn:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 1px var(--s-paper),
			0 0 0 2px var(--s-ink-3);
		border-radius: var(--s-radius-focus);
	}

	.s-glyph-label {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		opacity: 0;
		transform: translateY(2px);
		transition:
			opacity var(--s-t-quick) var(--s-ease),
			transform var(--s-t-quick) var(--s-ease);
		white-space: nowrap;
		pointer-events: none;
	}

	.s-glyph-cell:hover .s-glyph-label {
		opacity: 1;
		transform: none;
	}

	.s-glyph-btn[aria-pressed='true'] {
		color: var(--s-seal);
	}

	/* ── Conversation ─────────────────────────────────────────────────── */

	.s-scroll {
		position: relative;
		z-index: 10;
		height: 100dvh;
		overflow-y: auto;
		overflow-x: hidden;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		background: var(--s-paper);
		transition: background var(--s-t-theme) var(--s-ease);
		-webkit-mask-image: linear-gradient(
			to bottom,
			transparent 0,
			var(--s-paper) 17%,
			var(--s-paper) 84%,
			transparent 100%
		);
		mask-image: linear-gradient(
			to bottom,
			transparent 0,
			var(--s-paper) 17%,
			var(--s-paper) 84%,
			transparent 100%
		);
	}

	.s-scroll::-webkit-scrollbar {
		display: none;
	}

	.s-thread {
		max-width: var(--s-measure);
		margin: 0 auto;
		padding: 34vh var(--s-frame) 40vh;
		display: flex;
		flex-direction: column;
		gap: var(--s-breath);
	}

	/* two-voice turn styles used from ChatMessage and inline for pending */
	:global(.turn) {
		display: flex;
		flex-direction: column;
	}

	:global(.turn.you) {
		align-items: flex-end;
		text-align: right;
	}

	:global(.you-words) {
		font-family: var(--s-font-header);
		font-weight: 300;
		font-size: var(--s-type-whisper);
		line-height: 1.5;
		color: var(--s-ink-2);
		max-width: 80%;
		text-wrap: pretty;
		border-width: 0 0 var(--s-hair);
		border-style: solid;
		border-color: color-mix(in srgb, var(--s-ink) 10%, transparent);
		border-radius: 0 0 10px 0;
		padding: 0 var(--s-sp-4) var(--s-sp-2);
	}

	:global(.turn.master) {
		gap: 0.9rem;
	}

	:global(.master-words) {
		font-family: var(--s-font-header);
		font-weight: 300;
		font-size: 1.6rem;
		line-height: 1.42;
		letter-spacing: 0.002em;
		color: var(--s-ink);
		text-wrap: pretty;
		max-width: 80%;
		border-width: var(--s-hair) 0 3px;
		border-style: solid;
		border-color: color-mix(in srgb, var(--s-ink) 9%, transparent);
		border-radius: 20px;
		padding: var(--s-sp-3) var(--s-sp-4) var(--s-sp-4);
	}

	:global(.master-words p) {
		margin: 0 0 0.6rem 0;
	}

	:global(.master-words p:last-child) {
		margin-bottom: 0;
	}

	:global(.deed) {
		font-family: var(--s-font-mono);
		font-weight: 400;
		font-size: var(--s-type-deed);
		line-height: 1.5;
		color: var(--s-ink-2);
		padding-left: 1rem;
		position: relative;
		margin: 0.32rem 0;
	}

	:global(.deed::before) {
		content: '';
		position: absolute;
		left: 0;
		top: 0.55em;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--s-seal);
		opacity: 0.85;
	}

	:global(.deeds-inner) {
		border-left: var(--s-hair) solid var(--s-line);
		margin: 1rem 0 0 14px;
		padding: 0.3rem 0 0.3rem 1.1rem;
	}

	.s-loading {
		display: flex;
		justify-content: center;
		padding: var(--s-breath) 0;
	}

	.s-loading-text {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	/* ── Pending / streaming ──────────────────────────────────────────── */

	.s-pending {
		display: flex;
		flex-direction: column;
		gap: var(--s-breath);
	}

	.s-streaming {
		color: var(--s-ink) !important;
		white-space: pre-wrap;
	}

	.s-thinking {
		display: flex;
		align-items: center;
	}

	.s-thinking-text {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	.s-live-deeds {
		display: flex;
		flex-direction: column;
		border-left: var(--s-hair) solid var(--s-line);
	}

	/* ── Action cards (permission / question) ─────────────────────────── */

	.s-action-card {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		padding: 1rem 1.2rem;
		border-left: var(--s-hair) solid var(--s-seal);
		max-width: var(--s-measure-whisper);
	}

	.s-action-kicker {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-seal);
	}

	.s-action-title {
		font-family: var(--s-font-header);
		font-size: var(--s-type-whisper);
		color: var(--s-ink);
	}

	.s-action-question {
		font-family: var(--s-font-header);
		font-size: var(--s-type-whisper);
		color: var(--s-ink);
		margin: 0;
	}

	.s-action-body,
	.s-action-hint {
		font-family: var(--s-font-header);
		font-size: var(--s-type-whisper);
		color: var(--s-ink-2);
		margin: 0;
	}

	.s-action-code {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-deed);
		color: var(--s-ink-2);
		display: block;
		word-break: break-all;
	}

	.s-action-btns {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.2rem;
	}

	.s-action-options {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.s-action-btn {
		appearance: none;
		border: var(--s-hair) solid var(--s-line);
		background: none;
		cursor: pointer;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-deed);
		letter-spacing: var(--s-track-label);
		text-transform: lowercase;
		color: var(--s-ink-2);
		padding: 0.4rem 0.85rem;
		border-radius: var(--s-radius-seal);
		transition:
			color var(--s-t-quick) var(--s-ease),
			border-color var(--s-t-quick) var(--s-ease);
	}

	.s-action-btn:hover:not(:disabled) {
		color: var(--s-ink);
		border-color: var(--s-line);
	}

	.s-action-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.s-action-btn.selected {
		border-color: var(--s-moss);
		color: var(--s-moss);
	}

	.s-action-btn-primary {
		border-color: var(--s-seal);
		color: var(--s-seal);
	}

	.s-action-btn-danger {
		color: var(--s-ink-3);
	}

	.s-multi-questions {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}

	.s-question-item {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding-top: 0.6rem;
		border-top: var(--s-hair) solid var(--s-line-soft);
	}

	.s-question-item:first-child {
		padding-top: 0;
		border-top: 0;
	}

	.s-question-input {
		width: 100%;
		background: none;
		border: 0;
		border-bottom: var(--s-hair) solid var(--s-line);
		outline: 0;
		font-family: var(--s-font-header);
		font-size: var(--s-type-whisper);
		color: var(--s-ink);
		padding: 0.3rem 0;
	}

	.s-question-input::placeholder {
		color: var(--s-ink-3);
	}

	/* ── Presence + composer ──────────────────────────────────────────── */

	.s-base {
		position: fixed;
		z-index: 30;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0 var(--s-frame) clamp(1.4rem, 4vh, 2.4rem);
		background: linear-gradient(
			to top,
			var(--s-paper) 0%,
			var(--s-paper) 46%,
			color-mix(in srgb, var(--s-paper) 72%, transparent) 74%,
			transparent 100%
		);
		transition: background var(--s-t-theme) var(--s-ease);
		pointer-events: none;
	}

	.s-base > :global(*) {
		pointer-events: auto;
	}

	.s-base::before {
		content: '';
		position: absolute;
		left: 50%;
		bottom: 0;
		z-index: -1;
		width: min(34rem, 90%);
		height: 230px;
		transform: translateX(-50%);
		background: radial-gradient(
			60% 70% at 50% 64%,
			var(--s-paper) 0%,
			var(--s-paper) 40%,
			transparent 78%
		);
		pointer-events: none;
		transition: background var(--s-t-theme) var(--s-ease);
	}

	/* ── Error banner ─────────────────────────────────────────────────── */

	.s-error-banner {
		position: fixed;
		z-index: 50;
		bottom: clamp(6rem, 22vh, 10rem);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 1rem;
		border: var(--s-hair) solid var(--s-line);
		background: var(--s-paper);
		max-width: min(32rem, 90vw);
		width: max-content;
	}

	.s-error-msg {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-deed);
		color: var(--s-seal);
		flex: 1;
	}

	.s-error-reconnect,
	.s-error-dismiss {
		appearance: none;
		border: var(--s-hair) solid var(--s-line);
		background: none;
		cursor: pointer;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: lowercase;
		color: var(--s-ink-2);
		padding: 0.2rem 0.6rem;
		border-radius: var(--s-radius-seal);
		white-space: nowrap;
	}

	.s-error-reconnect:hover {
		color: var(--s-ink);
	}
	.s-error-dismiss {
		border: 0;
		padding: 0.2rem 0.4rem;
	}
	.s-error-dismiss:hover {
		color: var(--s-seal);
	}

	/* ── Garden veil ──────────────────────────────────────────────────── */

	.s-veil {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: var(--s-paper);
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 0.8s var(--s-ease),
			background var(--s-t-theme) var(--s-ease);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.s-veil.open {
		opacity: 1;
		pointer-events: auto;
	}

	.s-veil-head {
		padding: 20px 28px 14px;
		display: flex;
		align-items: baseline;
		gap: 1rem;
		max-width: var(--s-measure);
		width: 100%;
		margin: 0 auto;
		flex-shrink: 0;
		border-bottom: 1px solid var(--s-line-soft);
	}

	.s-veil-title {
		font-family: var(--s-font-header);
		font-weight: 400;
		font-size: 1.55rem;
		letter-spacing: 0.01em;
		color: var(--s-ink);
	}

	.s-veil-sub {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		margin-top: 0.3rem;
	}

	.s-veil-body {
		flex: 1;
		overflow-y: auto;
		scrollbar-width: none;
		margin: 0 auto;
		padding: 0.5rem clamp(1.4rem, 5vw, 3rem) clamp(2rem, 6vw, 3rem);
		width: 100%;
		max-width: var(--s-measure);
		display: flex;
		flex-direction: column;
		gap: clamp(2rem, 5vh, 3.2rem);
		min-height: 0;
	}

	.s-veil-body::-webkit-scrollbar {
		display: none;
	}

	.s-veil-section {
		display: flex;
		flex-direction: column;
	}

	.s-veil-section-label {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: 0.26em;
		text-transform: uppercase;
		color: var(--s-ink-3);
		margin-bottom: 0.7rem;
	}

	.s-section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0;
	}

	.s-section-head .s-veil-section-label {
		margin-bottom: 0;
	}

	.s-new-convo {
		appearance: none;
		border: 0;
		background: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		padding: 0;
		text-decoration: none;
		transition: color var(--s-t-quick) var(--s-ease);
	}

	.s-new-convo:hover {
		color: var(--s-seal);
	}

	.s-new-mark {
		color: var(--s-seal);
		font-size: 0.9rem;
		line-height: 1;
	}

	/* Endpoint list (inline Stillness style) */
	.s-endpoint-list {
		display: flex;
		flex-direction: column;
	}

	.s-endpoint {
		appearance: none;
		border: 0;
		background: none;
		cursor: pointer;
		text-align: left;
		width: 100%;
		position: relative;
		padding: 0.85rem 0 0.85rem 1.1rem;
		color: var(--s-ink);
		transition: none;
	}

	.s-endpoint::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0.7rem;
		bottom: 0.7rem;
		width: 2px;
		background: var(--s-seal);
		opacity: 0;
		transform: scaleY(0.4);
		transform-origin: center;
		transition:
			opacity 0.6s var(--s-ease),
			transform 0.6s var(--s-ease-settle);
	}

	.s-endpoint.active::before {
		opacity: 0.8;
		transform: scaleY(1);
	}

	.s-endpoint-label {
		font-family: var(--s-font-display);
		font-weight: 400;
		font-size: var(--s-type-whisper);
		color: var(--s-ink-2);
		transition: color var(--s-t-quick) var(--s-ease);
	}

	.s-endpoint.active .s-endpoint-label,
	.s-endpoint:hover .s-endpoint-label {
		color: var(--s-ink);
	}

	.s-endpoint-url {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: 0.06em;
		color: var(--s-ink-3);
		margin-top: 0.25rem;
	}

	.s-endpoint-item {
		display: flex;
		flex-direction: column;
	}

	.s-endpoint-manage {
		display: block;
		padding: 0.1rem 0 0.6rem 1.1rem;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		text-decoration: none;
		transition: color var(--s-t-quick) var(--s-ease);
	}

	.s-endpoint-manage:hover {
		color: var(--s-seal);
	}

	@media (max-width: 520px) {
		.s-thread {
			padding-top: 30vh;
			padding-bottom: 44vh;
		}
	}
</style>
