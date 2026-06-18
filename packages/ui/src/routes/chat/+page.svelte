<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import SessionList from '$lib/components/chat/SessionList.svelte';
  import { isLocalAssistantUrl } from '$lib/assistant-endpoint.js';
  import { probeChatBackend } from '$lib/api.js';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { buildAdvancedPath } from '$lib/chat/navigation.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { themeService } from '$lib/theme-state.svelte.js';
  import { voiceState, setTtsAutoEnabled, startListening, stopListening, initVoice } from '$lib/voice/voice-state.svelte.js';

  let scrollAnchorEl = $state<HTMLDivElement | undefined>();

  const entriesLoading = $derived(chat.entriesLoading);
  const sessionsLoading = $derived(
    chat.byEndpoint.get(chat.activeEndpointId)?.sessionsLoading ?? false
  );

  // ── Garden (session veil) ──────────────────────────────────────────
  let gardenOpen = $state(false);

  function openGarden(): void { gardenOpen = true; }
  function closeGarden(): void { gardenOpen = false; }

  // ── Enso ───────────────────────────────────────────────────────────
  let ensoDry = $state<SVGPathElement | undefined>();
  let ensoWet = $state<SVGPathElement | undefined>();
  let ensoRippleL1 = $state<SVGPathElement | undefined>();
  let ensoRippleL2 = $state<SVGPathElement | undefined>();
  let ensoRippleS1 = $state<SVGPathElement | undefined>();
  let ensoRippleS2 = $state<SVGPathElement | undefined>();
  let presenceEl = $state<HTMLElement | undefined>();
  let drawLen = 0;
  let ensoReady = false;

  function ensoPath(cx: number, cy: number, r: number): string {
    const start = -0.62 * Math.PI;
    const end = 1.30 * Math.PI;
    const steps = 130;
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = start + (end - start) * t;
      const wobble = Math.sin(a * 3.1 + 1) * 1.4 + Math.sin(a * 7.3) * 0.7;
      const taper = Math.sin(t * Math.PI);
      const rr = r + wobble + taper * 2.2;
      const x = cx + rr * Math.cos(a);
      const y = cy + rr * Math.sin(a);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
    }
    return d;
  }

  function drawEnso(): void {
    if (!ensoDry || !ensoWet || !presenceEl) return;
    presenceEl.classList.remove('breathing');
    [ensoDry, ensoWet].forEach(p => {
      p.style.transition = 'none';
      p.style.strokeDasharray = String(drawLen);
      p.style.strokeDashoffset = String(drawLen);
    });
    void ensoDry.getBoundingClientRect();
    [ensoDry, ensoWet].forEach(p => {
      p.style.transition = 'stroke-dashoffset var(--s-t-draw) var(--s-ease-draw)';
      p.style.strokeDashoffset = '0';
    });
  }

  function restEnso(): void {
    if (!ensoDry || !ensoWet || !presenceEl) return;
    [ensoDry, ensoWet].forEach(p => {
      p.style.transition = 'opacity 0.6s ease';
      p.style.strokeDasharray = 'none';
    });
    presenceEl.classList.add('breathing');
  }

  $effect(() => {
    if (!ensoReady) return;
    if (chat.sending) {
      drawEnso();
    } else {
      restEnso();
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  async function reconnect(): Promise<void> {
    chat.error = '';
    await chat.loadSessions();
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

  function scrollToBottom(): void {
    queueMicrotask(() => {
      scrollAnchorEl?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  let lastSeenPermissionId = '';
  let lastSeenQuestionId = '';

  $effect(() => {
    const lastEntry = chat.entries.at(-1);
    const lastEntryContent =
      lastEntry?.type === 'divider'
        ? lastEntry.label
        : lastEntry?.type === 'note'
          ? lastEntry.text
          : lastEntry?.type === 'tool-group'
            ? (lastEntry.toolStates[0]?.title ?? '')
            : lastEntry?.text ?? '';

    if (!lastEntry && !entriesLoading && !sessionsLoading && !chat.sending) return;

    const permissionId = chat.pendingPermission?.requestID ?? '';
    const questionId = chat.pendingQuestion?.requestID ?? '';
    const permissionChanged = permissionId !== lastSeenPermissionId;
    const questionChanged = questionId !== lastSeenQuestionId;

    lastEntryContent;
    chat.pendingAssistantText;
    chat.pendingToolStates.length;

    if (permissionChanged) lastSeenPermissionId = permissionId;
    if (questionChanged) lastSeenQuestionId = questionId;

    if (lastEntry || entriesLoading || sessionsLoading || chat.sending || permissionChanged || questionChanged) {
      scrollToBottom();
    }
  });

  function clamp(text: string, max = 160): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // ── Body class management ─────────────────────────────────────────────
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.add('chat-locked');
    document.body.classList.add('chat-locked', 'stillness-mode');
    return () => {
      document.documentElement.classList.remove('chat-locked');
      document.body.classList.remove('chat-locked', 'stillness-mode');
    };
  });

  // ── Keyboard: escape closes garden ───────────────────────────────────
  $effect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') closeGarden();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // ── Visibility-change reconnect ───────────────────────────────────────
  $effect(() => {
    let destroyed = false;
    function handleVisibilityChange(): void {
      if (destroyed || document.visibilityState !== 'visible') return;
      void (async () => {
        const reachable = await probeChatBackend();
        if (!reachable && !destroyed) {
          chat.error = 'Assistant is not reachable. Try reconnecting.';
        }
      })();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      destroyed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  // ── Voice / TTS ───────────────────────────────────────────────────────

  const voiceActive = $derived(voiceState.status === 'recording' || voiceState.status === 'transcribing');
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
    if (id === endpointsService.active?.id) { closeGarden(); return; }
    endpointSwitching = true;
    try {
      await endpointsService.activate(id);
      closeGarden();
    } catch { /* error surfaced via endpointsService.error */ }
    finally { endpointSwitching = false; }
  }

  // ── Mount ─────────────────────────────────────────────────────────────
  onMount(() => {
    void initVoice();

    // Enso setup
    if (ensoDry && ensoWet) {
      const path = ensoPath(60, 62, 44);
      ensoDry.setAttribute('d', path);
      ensoWet.setAttribute('d', path);
      // Set ripple paths (slightly different radii for variation)
      const ripple1 = ensoPath(60, 62, 46);
      const ripple2 = ensoPath(60, 62, 50);
      ensoRippleL1?.setAttribute('d', ripple1);
      ensoRippleL2?.setAttribute('d', ripple2);
      ensoRippleS1?.setAttribute('d', ripple1);
      ensoRippleS2?.setAttribute('d', ripple2);
      try { drawLen = ensoDry.getTotalLength(); } catch { drawLen = 360; }
      drawEnso();
      setTimeout(() => {
        restEnso();
        ensoReady = true;
      }, 2400);
    }

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
  });
</script>

<svelte:head>
  <title>Stillness</title>
</svelte:head>

<!-- atmosphere -->
<div class="s-field"></div>
<div class="s-moon"></div>
<div class="s-grain"></div>

<!-- SVG filter defs: ink brush + bloom -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <filter id="s-brush" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.026" numOctaves="2" seed="7" result="t"/>
      <feDisplacementMap in="SourceGraphic" in2="t" scale="3.4" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="s-bloom" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="2.4"/>
    </filter>
  </defs>
</svg>

<!-- corners: the only persistent chrome -->
<!-- top-left: theme toggle -->
<div class="s-corner s-corner-left">
  <button
    class="s-glyph-btn s-orb-btn"
    type="button"
    onclick={() => themeService.toggle()}
    aria-label="Switch between day and night"
  >
    <svg class="s-toggle-orb" viewBox="0 0 30 30" aria-hidden="true">
      <circle cx="15" cy="15" r="8" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path
        class="s-orb-half"
        d="M15 7a8 8 0 0 1 0 16z"
        class:night={themeService.resolved === 'dark'}
      />
    </svg>
  </button>
  <span class="s-glyph-label">day &amp; night</span>
</div>

<!-- top-right: advanced -->
<div class="s-corner s-corner-right">
  <button
    class="s-glyph-btn"
    type="button"
    aria-label="Advanced mode"
    aria-pressed={advancedModeService.enabled}
    onclick={() => void goto(buildAdvancedPath(null))}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2.5"/>
      <path d="m7.5 9 3 3-3 3"/><line x1="13" y1="15" x2="17" y2="15"/>
    </svg>
  </button>
  <span class="s-glyph-label">advanced</span>
</div>

<!-- bottom-left: conversations -->
<div class="s-corner s-corner-bottom-left">
  <button
    class="s-glyph-btn"
    type="button"
    onclick={openGarden}
    aria-label="Conversations"
  >
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <line x1="4" y1="7" x2="18" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.85"/>
      <line x1="4" y1="11" x2="14" y2="11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.6"/>
      <line x1="4" y1="15" x2="16.5" y2="15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.45"/>
    </svg>
  </button>
  <span class="s-glyph-label">conversations</span>
</div>

<!-- bottom-right: speak (mic is the enso) -->
{#if ttsAvailable}
  <div class="s-corner s-corner-bottom-right">
    <button
      class="s-glyph-btn"
      type="button"
      aria-label={ttsEnabled ? 'Turn off spoken responses' : 'Turn on spoken responses'}
      aria-pressed={ttsEnabled}
      onclick={toggleSpeak}
    >
      {#if ttsEnabled}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H2v6h4l5 4V5z"/>
          <path d="M15.5 8.7a4.5 4.5 0 0 1 0 6.6"/><path d="M18.4 6.2a8 8 0 0 1 0 11.6"/>
        </svg>
      {:else}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H2v6h4l5 4V5z"/>
          <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
        </svg>
      {/if}
    </button>
    <span class="s-glyph-label">speak</span>
  </div>
{/if}

<!-- conversation thread -->
<main class="s-scroll" id="s-scroll" aria-label="Chat history">
  <div class="s-thread" id="s-thread">

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
                <div class="deed">{tool.title}</div>
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
                disabled={chat.pendingPermission.status === 'submitting' || chat.pendingPermission.status === 'resolved'}
              >
                {permissionActionInFlight === 'once' ? 'sending…' : 'allow this once'}
              </button>
              <button
                class="s-action-btn"
                type="button"
                onclick={() => void handlePermissionReply('always')}
                disabled={chat.pendingPermission.status === 'submitting' || chat.pendingPermission.status === 'resolved'}
              >
                {permissionActionInFlight === 'always' ? 'sending…' : 'always allow'}
              </button>
              <button
                class="s-action-btn s-action-btn-danger"
                type="button"
                onclick={() => void handlePermissionReply('reject')}
                disabled={chat.pendingPermission.status === 'submitting' || chat.pendingPermission.status === 'resolved'}
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
                      disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}
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
                            disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}
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
                      disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}
                    />
                  </div>
                {/each}
              </div>
              <div class="s-action-btns">
                <button
                  class="s-action-btn s-action-btn-primary"
                  type="button"
                  onclick={() => void handleQuestionSubmit()}
                  disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}
                >
                  submit answers
                </button>
                <button
                  class="s-action-btn"
                  type="button"
                  onclick={() => void handleQuestionReject()}
                  disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}
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
    <button class="s-error-dismiss" type="button" aria-label="Dismiss" onclick={() => { chat.error = ''; }}>×</button>
  </div>
{/if}

<!-- presence + composer -->
<div class="s-base">
  {#if voiceEnabled}
    <button
      class="s-presence breathing"
      id="s-presence"
      type="button"
      bind:this={presenceEl}
      class:listening={voiceState.status === 'recording'}
      class:speaking={voiceState.status === 'speaking'}
      aria-label={voiceState.status === 'recording' ? 'Stop listening' : 'Speak to the agent'}
      aria-pressed={voiceState.status === 'recording'}
      onclick={toggleVoice}
    >
      <svg class="s-enso" viewBox="0 0 120 120" id="s-enso" aria-hidden="true">
        <path class="s-ripple s-ripple-speak s-r1" bind:this={ensoRippleS1}></path>
        <path class="s-ripple s-ripple-speak s-r2" bind:this={ensoRippleS2}></path>
        <path class="s-ripple s-ripple-listen s-l1" bind:this={ensoRippleL1}></path>
        <path class="s-ripple s-ripple-listen s-l2" bind:this={ensoRippleL2}></path>
        <path class="s-wet" bind:this={ensoWet}></path>
        <path class="s-dry" bind:this={ensoDry}></path>
      </svg>
    </button>
  {:else}
    <div
      class="s-presence breathing"
      id="s-presence"
      bind:this={presenceEl}
      class:speaking={voiceState.status === 'speaking'}
    >
      <svg class="s-enso" viewBox="0 0 120 120" id="s-enso" aria-hidden="true">
        <path class="s-ripple s-ripple-speak s-r1" bind:this={ensoRippleS1}></path>
        <path class="s-ripple s-ripple-speak s-r2" bind:this={ensoRippleS2}></path>
        <path class="s-ripple s-ripple-listen s-l1" bind:this={ensoRippleL1}></path>
        <path class="s-ripple s-ripple-listen s-l2" bind:this={ensoRippleL2}></path>
        <path class="s-wet" bind:this={ensoWet}></path>
        <path class="s-dry" bind:this={ensoDry}></path>
      </svg>
    </div>
  {/if}
  <ChatInput
    sending={chat.sending}
    questionPending={!!chat.pendingQuestion && chat.pendingQuestion.questions.length === 1}
    onSend={handleSend}
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
      <div class="s-veil-title">The garden</div>
      {#if endpointsService.active}
        <div class="s-veil-sub">{endpointsService.active.label}</div>
      {/if}
    </div>
    <button class="s-glyph-btn" type="button" onclick={closeGarden} aria-label="Return to the conversation">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    </button>
  </div>

  <div class="s-veil-body">
    <section class="s-veil-section">
      <div class="s-veil-section-label">assistant</div>
      <div class="s-endpoint-list" role="group" aria-label="Assistant endpoints">
        {#each endpointsService.endpoints as ep (ep.id)}
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
        {/each}
        {#if isLocalAssistantUrl(endpointsService.active?.url)}
          <a class="s-manage" href="/admin" onclick={closeGarden}>manage this assistant…</a>
        {/if}
        <a class="s-manage" href="/admin/endpoints" onclick={closeGarden}>manage assistant connections…</a>
      </div>
    </section>

    <section class="s-veil-section">
      <div class="s-section-head">
        <div class="s-veil-section-label">conversations</div>
        <button class="s-new-convo" type="button" onclick={() => void beginNew()}>
          <span class="s-new-mark" aria-hidden="true">+</span> begin anew
        </button>
      </div>
      <SessionList onChosen={closeGarden} />
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
    background:
      radial-gradient(120% 80% at 50% 14%, transparent 38%, var(--s-paper-deep) 100%);
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
    background: radial-gradient(circle at 38% 38%, rgba(218,214,201,0.10), rgba(218,214,201,0.02) 55%, transparent 70%);
  }

  .s-grain {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    opacity: var(--s-paper-grain);
    mix-blend-mode: soft-light;
    background-image: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNjAnIGhlaWdodD0nMTYwJz48ZmlsdGVyIGlkPSduJz48ZmVUdXJidWxlbmNlIHR5cGU9J2ZyYWN0YWxOb2lzZScgYmFzZUZyZXF1ZW5jeT0nMC45JyBudW1PY3RhdmVzPScyJyBzdGl0Y2hUaWxlcz0nc3RpdGNoJy8+PC9maWx0ZXI+PHJlY3Qgd2lkdGg9JzEwMCUnIGhlaWdodD0nMTAwJScgZmlsdGVyPSd1cmwoI24pJy8+PC9zdmc+");
  }

  /* ── Corners ──────────────────────────────────────────────────────── */

  .s-corner {
    position: fixed;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: var(--s-chrome-pad);
  }

  .s-corner-left { top: 0; left: 0; }
  .s-corner-right { top: 0; right: 0; flex-direction: row-reverse; align-items: flex-start; }
  .s-corner-bottom-left { bottom: 0; left: 0; }
  .s-corner-bottom-right { bottom: 0; right: 0; flex-direction: row-reverse; }

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
    transition: color var(--s-t-quick) var(--s-ease), transform 0.6s var(--s-ease);
  }

  .s-glyph-btn:hover { color: var(--s-ink); }
  .s-glyph-btn:active { transform: scale(0.94); }
  .s-glyph-btn svg { display: block; }

  .s-glyph-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1px var(--s-paper), 0 0 0 2px var(--s-ink-3);
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
    transition: opacity var(--s-t-quick) var(--s-ease), transform var(--s-t-quick) var(--s-ease);
    white-space: nowrap;
    pointer-events: none;
  }

  .s-corner-left:hover .s-glyph-label,
  .s-corner-right:hover .s-glyph-label,
  .s-corner-bottom-left:hover .s-glyph-label,
  .s-corner-bottom-right:hover .s-glyph-label {
    opacity: 1;
    transform: none;
  }

  .s-glyph-btn[aria-pressed="true"] { color: var(--s-seal); }

  .s-toggle-orb {
    width: 30px;
    height: 30px;
  }

  .s-orb-half {
    fill: currentColor;
    transition: transform 0.9s var(--s-ease);
    transform-origin: 15px 15px;
  }

  .s-orb-half.night {
    transform: rotate(180deg);
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
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, var(--s-paper) 17%, var(--s-paper) 84%, transparent 100%);
            mask-image: linear-gradient(to bottom, transparent 0, var(--s-paper) 17%, var(--s-paper) 84%, transparent 100%);
  }

  .s-scroll::-webkit-scrollbar { display: none; }

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

  :global(.turn.you) { gap: 0.5rem; }

  :global(.you-mark) {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-mark);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  :global(.you-words) {
    font-family: var(--s-font-display);
    font-weight: 400;
    font-size: var(--s-type-whisper);
    line-height: var(--s-type-whisper-lh);
    color: var(--s-ink-2);
    max-width: var(--s-measure-whisper);
  }

  :global(.turn.master) { gap: 0.9rem; }

  :global(.master-words) {
    font-family: var(--s-font-display);
    font-weight: 400;
    font-size: var(--s-type-voice);
    line-height: var(--s-type-voice-lh);
    letter-spacing: 0.002em;
    color: var(--s-ink);
    text-wrap: pretty;
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
    content: "";
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
    font-family: var(--s-font-display);
    font-size: var(--s-type-whisper);
    color: var(--s-ink);
  }

  .s-action-question {
    font-family: var(--s-font-display);
    font-size: var(--s-type-whisper);
    color: var(--s-ink);
    margin: 0;
  }

  .s-action-body,
  .s-action-hint {
    font-family: var(--s-font-display);
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
    transition: color var(--s-t-quick) var(--s-ease), border-color var(--s-t-quick) var(--s-ease);
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
    font-family: var(--s-font-display);
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
    background: linear-gradient(to top,
      var(--s-paper) 0%,
      var(--s-paper) 46%,
      color-mix(in srgb, var(--s-paper) 72%, transparent) 74%,
      transparent 100%);
    transition: background var(--s-t-theme) var(--s-ease);
    pointer-events: none;
  }

  .s-base > :global(*) {
    pointer-events: auto;
  }

  .s-base::before {
    content: "";
    position: absolute;
    left: 50%;
    bottom: 0;
    z-index: -1;
    width: min(34rem, 90%);
    height: 230px;
    transform: translateX(-50%);
    background: radial-gradient(60% 70% at 50% 64%, var(--s-paper) 0%, var(--s-paper) 40%, transparent 78%);
    pointer-events: none;
    transition: background var(--s-t-theme) var(--s-ease);
  }

  .s-presence {
    width: var(--s-enso-size);
    height: var(--s-enso-size);
    margin-bottom: 0.5rem;
    position: relative;
    appearance: none;
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
    display: block;
  }

  div.s-presence {
    cursor: default;
  }

  .s-presence.breathing {
    animation: s-breathe var(--s-breathe-dur) ease-in-out infinite;
  }

  .s-enso {
    overflow: visible;
  }

  .s-dry {
    fill: none;
    stroke: var(--s-ink);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: url(#s-brush);
    transition: stroke var(--s-t-theme) var(--s-ease);
  }

  .s-wet {
    fill: none;
    stroke: var(--s-ink);
    opacity: 0.16;
    stroke-width: 6.5;
    filter: url(#s-bloom);
  }

  /* ── Enso ripple states (voice listening / speaking) ─────────────── */

  .s-ripple {
    fill: none;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0;
    filter: url(#s-brush);
    transform-box: fill-box;
    transform-origin: center;
    pointer-events: none;
  }

  .s-ripple-listen { stroke: var(--s-seal); }
  .s-ripple-speak  { stroke: var(--s-ink); }

  .s-presence.listening .s-dry {
    stroke: color-mix(in srgb, var(--s-ink) 74%, var(--s-seal));
  }

  .s-presence.listening .s-ripple-listen {
    animation: s-listen-in 4s var(--s-ease) infinite;
  }

  .s-presence.listening .s-ripple-listen.s-l2 {
    animation-delay: 2s;
  }

  @keyframes s-listen-in {
    0%   { opacity: 0;   transform: scale(1.32) rotate(-6deg); }
    50%  { opacity: .32; }
    100% { opacity: 0;   transform: scale(.96) rotate(3deg); }
  }

  .s-presence.speaking .s-ripple-speak {
    animation: s-speak-out 4s var(--s-ease) infinite;
  }

  .s-presence.speaking .s-ripple-speak.s-r2 {
    animation-delay: 2s;
  }

  @keyframes s-speak-out {
    0%   { opacity: .3; transform: scale(.9) rotate(-3deg); }
    100% { opacity: 0;  transform: scale(1.34) rotate(6deg); }
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

  .s-error-reconnect:hover { color: var(--s-ink); }
  .s-error-dismiss { border: 0; padding: 0.2rem 0.4rem; }
  .s-error-dismiss:hover { color: var(--s-seal); }

  /* ── Garden veil ──────────────────────────────────────────────────── */

  .s-veil {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--s-paper);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.8s var(--s-ease), background var(--s-t-theme) var(--s-ease);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .s-veil.open {
    opacity: 1;
    pointer-events: auto;
  }

  .s-veil-head {
    padding: clamp(1.4rem, 5vw, 2.4rem);
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    max-width: var(--s-measure);
    width: 100%;
    margin: 0 auto;
    flex-shrink: 0;
  }

  .s-veil-title {
    font-family: var(--s-font-display);
    font-weight: 400;
    font-size: clamp(1.5rem, 4vw, 1.9rem);
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

  .s-veil-body::-webkit-scrollbar { display: none; }

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
    transition: color var(--s-t-quick) var(--s-ease);
  }

  .s-new-convo:hover { color: var(--s-seal); }

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
    content: "";
    position: absolute;
    left: 0;
    top: 0.7rem;
    bottom: 0.7rem;
    width: 2px;
    background: var(--s-seal);
    opacity: 0;
    transform: scaleY(0.4);
    transform-origin: center;
    transition: opacity 0.6s var(--s-ease), transform 0.6s var(--s-ease-settle);
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

  .s-manage {
    appearance: none;
    border: 0;
    background: none;
    cursor: pointer;
    text-align: left;
    display: block;
    padding: 0.55rem 0 0.55rem 1.1rem;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    text-decoration: none;
    transition: color var(--s-t-quick) var(--s-ease);
  }

  .s-manage:hover { color: var(--s-ink); }

  .s-manage:first-of-type {
    margin-top: 0.4rem;
    border-top: var(--s-hair) solid var(--s-line-soft);
    padding-top: 1rem;
  }

  @media (max-width: 520px) {
    .s-thread {
      padding-top: 30vh;
      padding-bottom: 44vh;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .s-presence { animation: none !important; }
    .s-ripple { animation: none !important; }
    .s-presence.listening .s-ripple-listen { opacity: 0.22; }
    .s-presence.speaking  .s-ripple-speak  { opacity: 0.22; }
  }
</style>
