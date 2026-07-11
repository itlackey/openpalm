<script lang="ts">
  // B4 [HIGH] (review 2026-07-10) — copied from packages/ui ChatMessage's
  // QuestionCard.svelte (git show 455d8728 lineage) and adapted to the
  // client's own PendingQuestionState (chat-controller.ts) instead of the
  // host app's chat-state.svelte.js. Without this, a structured question the
  // assistant asked was unanswerable, wedging the turn for 150s.
  import type { PendingQuestionState } from '$lib/chat/chat-controller.js';

  interface Props {
    question: PendingQuestionState;
    /** Single-question quick-answer (option click submits directly). */
    onOption: (label: string) => void;
    /** Multi-question option select (records the answer at `index`). */
    onSelect: (index: number, label: string) => void;
    /** Free-text answer drafted at `index`. */
    onDraft: (index: number, value: string) => void;
    onSubmit: () => void;
    onReject: () => void;
  }

  let { question, onOption, onSelect, onDraft, onSubmit, onReject }: Props = $props();

  // Controls lock once answering is in flight or the exchange is done.
  const locked = $derived(
    question.status === 'submitting' ||
      question.status === 'answered' ||
      question.status === 'rejected'
  );
</script>

<div class="s-action-card" role="group" aria-label="Assistant question">
  <div class="s-action-kicker">a question for you</div>
  {#if question.questions.length === 1 && question.questions[0]}
    <p class="s-action-question">{question.questions[0].question}</p>
    {#if question.questions[0].options.length > 0}
      <div class="s-action-options">
        {#each question.questions[0].options as option, index (`${question.requestID}:${index}`)}
          <button
            class="s-action-btn"
            type="button"
            onclick={() => onOption(option.label)}
            disabled={locked}
          >
            {option.label}
          </button>
        {/each}
      </div>
      <p class="s-action-hint">or write your answer below</p>
    {/if}
    <!-- P1 (review 2026-07-11): a single options:[] question used to render
         NOTHING past this point — no free-text input, no submit, no reject
         — making it unanswerable and undeclineable. Mirrors the multi-
         question branch's controls (the else case just below). -->
    <input
      class="s-question-input"
      type="text"
      value={question.answers[0]}
      placeholder="Type an answer"
      oninput={(event) => onDraft(0, (event.currentTarget as HTMLInputElement).value)}
      disabled={locked}
    />
    <div class="s-action-btns">
      <button
        class="s-action-btn s-action-btn-primary"
        type="button"
        onclick={() => onSubmit()}
        disabled={locked}
      >
        submit answer
      </button>
      <button class="s-action-btn" type="button" onclick={() => onReject()} disabled={locked}>
        can't answer
      </button>
    </div>
  {:else}
    <div class="s-multi-questions">
      {#each question.questions as item, index (`${question.requestID}:question:${index}`)}
        <div class="s-question-item">
          {#if item.header}
            <div class="s-action-kicker">{item.header}</div>
          {/if}
          <p class="s-action-question">{item.question}</p>
          {#if item.options.length > 0}
            <div class="s-action-options">
              {#each item.options as option, optionIndex (`${question.requestID}:${index}:${optionIndex}`)}
                <button
                  class="s-action-btn"
                  class:selected={question.answers[index] === option.label}
                  type="button"
                  onclick={() => onSelect(index, option.label)}
                  disabled={locked}
                >
                  {option.label}
                </button>
              {/each}
            </div>
          {/if}
          <input
            class="s-question-input"
            type="text"
            value={question.answers[index]}
            placeholder="Type an answer"
            oninput={(event) => onDraft(index, (event.currentTarget as HTMLInputElement).value)}
            disabled={locked}
          />
        </div>
      {/each}
    </div>
    <div class="s-action-btns">
      <button
        class="s-action-btn s-action-btn-primary"
        type="button"
        onclick={() => onSubmit()}
        disabled={locked}
      >
        submit answers
      </button>
      <button class="s-action-btn" type="button" onclick={() => onReject()} disabled={locked}>
        can't answer
      </button>
    </div>
  {/if}
</div>

<style>
  .s-action-card {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    padding: 1rem 1.2rem;
    border-left: var(--s-hair) solid var(--s-seal);
    max-width: var(--s-measure-whisper, 32rem);
  }

  .s-action-kicker {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm, var(--s-type-mark));
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-seal);
  }

  .s-action-question {
    font-family: var(--s-font-header);
    font-size: var(--s-type-whisper, var(--s-type-deed));
    color: var(--s-ink);
    margin: 0;
  }

  .s-action-hint {
    font-family: var(--s-font-header);
    font-size: var(--s-type-whisper, var(--s-type-deed));
    color: var(--s-ink-2);
    margin: 0;
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
    border-radius: var(--s-radius-seal, 4px);
    min-height: 44px;
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
    border-color: var(--s-moss, var(--s-seal));
    color: var(--s-moss, var(--s-seal));
  }

  .s-action-btn-primary {
    border-color: var(--s-seal);
    color: var(--s-seal);
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
    font-size: var(--s-type-whisper, var(--s-type-deed));
    color: var(--s-ink);
    padding: 0.3rem 0;
  }

  .s-question-input::placeholder {
    color: var(--s-ink-3);
  }
</style>
