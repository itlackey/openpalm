/**
 * AudioPlaybackController — the imperative TTS audio engine extracted from
 * voice-state.svelte.ts. Owns the speak queue, the HTMLAudioElement +
 * blob-URL lifecycle, the browser autoplay-policy fallback, and the
 * per-utterance playback (playOne). The reactive `voiceState` store
 * composes an instance of this and delegates speak/resume/stop to it.
 *
 * The controller never holds reactive `$state` itself — it mutates the
 * host store's reactive fields (status / errorMessage / autoplayBlocked)
 * through the `AudioPlaybackHost` it is constructed with, exactly as the
 * old module-global engine mutated `voiceState` directly.
 *
 * Only touch browser APIs (window, Audio, AudioContext, speechSynthesis)
 * from methods — never at construction — for SSR safety.
 */
import { notifications } from '$lib/notifications.svelte.js';
import { toSpeakableText } from './speakable-text.js';
import { synthesize } from './providers.js';
import type { TtsEngine, VoiceStatus } from './voice-state.svelte.js';

/**
 * The slice of the reactive voice store the audio engine reads and writes.
 * `voiceState` structurally satisfies this — passing it keeps Svelte
 * reactivity intact because the controller mutates the same proxied
 * instance.
 */
export interface AudioPlaybackHost {
  status: VoiceStatus;
  errorMessage: string;
  autoplayBlocked: boolean;
  readonly ttsEngine: TtsEngine;
}

// Cap on queued utterances. Streamed replies arrive one short sentence at a
// time, so a long reply can legitimately queue a dozen entries; past the cap
// the oldest drops. Keeps memory bounded if the assistant streams a flurry.
const SPEAK_QUEUE_MAX = 20;

export class AudioPlaybackController {
  private readonly host: AudioPlaybackHost;

  /**
   * Optional hook fired when the speak queue fully drains (the last
   * utterance reached a terminal state with nothing queued behind it).
   * Conversation mode uses this to re-arm listening — an explicit
   * callback instead of polling reactive status. Deliberately NOT fired
   * from stop(): an explicit stop (barge-in, toggle off) must not re-arm
   * anything by itself.
   */
  onQueueDrained: (() => void) | null = null;

  // Holds the currently-playing server-TTS audio element so stop() can
  // cancel it. Browser TTS is cancelled via window.speechSynthesis.
  private activeAudio: HTMLAudioElement | null = null;
  private activeAudioUrl: string | null = null;

  private readonly speakQueue: string[] = [];

  // True from playOne entry until the utterance reaches a terminal state
  // (ended, errored, skipped as unspeakable, or no engine available).
  // `host.status` only flips to 'speaking' AFTER the provider synthesis
  // fetch resolves, so it cannot serialize streamed chunks — a burst of
  // speakText calls during synthesis would otherwise start overlapping
  // playOne pipelines. Autoplay-blocked audio keeps this true as well:
  // later chunks must queue behind the stashed utterance until resume().
  private busy = false;

  // Bumped by stop() so a playOne suspended on the synthesis fetch can
  // detect the cancellation when it resumes and discard the audio instead
  // of playing an utterance the user already silenced. Browser-TTS
  // utterance callbacks carry the same check: a cancelled utterance's
  // late onend/onerror must not touch state owned by a newer generation.
  private generation = 0;

  // Have we already toasted the user about an overflow drop in the current
  // burst? Reset back to false when the queue drains so a NEW burst can
  // surface a fresh notification (rather than the user getting spammed
  // once per dropped utterance).
  private overflowNoticed = false;

  // Autoplay retry — when the browser rejects audio.play(), we stash the
  // audio and wait for the user to click the dedicated "click to resume"
  // banner (rendered in VoiceControl). Listening on `document` is what
  // caused arbitrary clicks elsewhere on the page to trigger stale audio.
  private pendingAutoplayAudio: HTMLAudioElement | null = null;
  private pendingAutoplayUrl: string | null = null;

  constructor(host: AudioPlaybackHost) {
    this.host = host;
  }

  /**
   * Play a 1-frame silent AudioBuffer through a transient AudioContext to
   * register the current user gesture with the browser's autoplay policy.
   * Safe to call repeatedly; failures are swallowed.
   */
  primeForAutoplay(): void {
    if (typeof window === 'undefined') return;
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      // Close shortly after — the gesture is captured the moment we play.
      setTimeout(() => {
        void ctx.close().catch(() => {
          /* already closed */
        });
      }, 100);
    } catch {
      /* AudioContext blocked — nothing we can do without a fresh gesture */
    }
  }

  private teardownActiveAudio(): void {
    if (this.activeAudio) {
      // Detach handlers BEFORE clearing src. Setting `audio.src = ''`
      // synthesizes a MediaError code 4 (SRC_NOT_SUPPORTED) on most
      // browsers; if onerror is still wired, it fires and surfaces
      // "Audio playback failed." even though playback completed
      // successfully (onended just ran and called us).
      this.activeAudio.onerror = null;
      this.activeAudio.onended = null;
      try { this.activeAudio.pause(); } catch { /* noop */ }
      this.activeAudio.src = '';
      this.activeAudio = null;
    }
    if (this.activeAudioUrl) {
      URL.revokeObjectURL(this.activeAudioUrl);
      this.activeAudioUrl = null;
    }
  }

  private teardownPendingAutoplay(): void {
    if (this.pendingAutoplayAudio) {
      // Same handler-clear-before-src=''-trick as teardownActiveAudio:
      // the assignment fires a phantom MediaError on cleanup, and any
      // onerror handler attached later (resume reuses this element)
      // would receive it.
      this.pendingAutoplayAudio.onerror = null;
      this.pendingAutoplayAudio.onended = null;
      try { this.pendingAutoplayAudio.pause(); } catch { /* noop */ }
      this.pendingAutoplayAudio.src = '';
      this.pendingAutoplayAudio = null;
    }
    if (this.pendingAutoplayUrl) {
      URL.revokeObjectURL(this.pendingAutoplayUrl);
      this.pendingAutoplayUrl = null;
    }
    this.host.autoplayBlocked = false;
  }

  /**
   * User clicked the "click to resume" banner — promote the stashed audio
   * to the active slot and play. Called from VoiceControl's banner button;
   * the click on the button itself satisfies the autoplay-policy gesture
   * requirement.
   */
  resume(): void {
    const a = this.pendingAutoplayAudio;
    if (!a) {
      this.host.autoplayBlocked = false;
      return;
    }
    this.host.autoplayBlocked = false;
    this.host.errorMessage = '';
    this.host.status = 'speaking';
    this.busy = true;
    // Promote pending → active so onended/onerror/teardown work. The
    // handlers attached in playOne are still wired, so the queue (which
    // kept accumulating while blocked) drains when this utterance ends.
    this.activeAudio = a;
    this.activeAudioUrl = this.pendingAutoplayUrl;
    this.pendingAutoplayAudio = null;
    this.pendingAutoplayUrl = null;
    a.play().catch(() => {
      this.host.status = 'idle';
      this.host.errorMessage = 'Audio playback failed.';
      this.teardownActiveAudio();
      this.drainNext();
    });
  }

  /**
   * Read text aloud using only the selected provider. A server-provider
   * failure is surfaced rather than silently switching to browser speech.
   *
   * If a previous utterance is still synthesizing, playing, or stashed
   * behind an autoplay block, queues this one (FIFO, cap 20) instead of
   * cutting it off mid-sentence.
   */
  async speak(text: string): Promise<void> {
    if (typeof window === 'undefined' || !text.trim()) return;

    // Queue if the pipeline is occupied (synthesis in flight, audio
    // playing, or autoplay-blocked). drainNext advances the queue from
    // every terminal path.
    if (this.busy) {
      this.speakQueue.push(text);
      // Drop oldest if over cap, and let the user know once per burst
      // so they understand WHY they're missing replies.
      let dropped = 0;
      while (this.speakQueue.length > SPEAK_QUEUE_MAX) {
        this.speakQueue.shift();
        dropped += 1;
      }
      if (dropped > 0 && !this.overflowNoticed) {
        this.overflowNoticed = true;
        notifications.push(
          'info',
          `Skipped ${dropped} spoken ${dropped === 1 ? 'reply' : 'replies'} — too much overlap. Lower the auto-speak chat rate.`,
        );
      }
      return;
    }

    await this.playOne(text);
  }

  /**
   * Advance the pump: play the next queued utterance, or release the busy
   * flag so a future speak() can start a fresh burst. Every terminal path
   * of an utterance must land here (or hold `busy` deliberately, as the
   * autoplay-block stash does).
   */
  private drainNext(): void {
    const next = this.speakQueue.shift();
    if (next) {
      void this.playOne(next);
    } else {
      this.busy = false;
      this.overflowNoticed = false;
      this.onQueueDrained?.();
    }
  }

  /** Internal: actually trigger the audio for one text chunk. */
  private async playOne(text: string): Promise<void> {
    if (typeof window === 'undefined') return;
    this.busy = true;
    const gen = this.generation;

    // Strip markdown once, up front, so neither the server request body nor
    // browser TTS ever speaks raw markdown syntax aloud. The
    // server applies the same deterministic stripping defensively.
    const speakableText = toSpeakableText(text);
    if (!speakableText) {
      // Nothing left to say (e.g. a reply that was pure markdown noise) —
      // skip straight to the next queued utterance instead of stalling
      // the queue on a chunk that would never fire onended/onerror.
      this.drainNext();
      return;
    }

    this.teardownActiveAudio();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.host.errorMessage = '';

    const engine = this.host.ttsEngine;
    const useServer = engine === 'openpalm-voice' || engine === 'remote';

    if (useServer) {
      this.host.status = 'preparing';
      let res: Response | undefined | null;
      try {
        // Direct browser → provider call (the configured OpenAI-compatible
        // endpoint or the host's voice container). Null = no server target
        // configured.
        res = await synthesize(speakableText);
      } catch {
        if (gen !== this.generation) return;
        this.host.errorMessage = 'Could not reach the selected text-to-speech provider.';
        this.host.status = 'idle';
        this.drainNext();
        return;
      }
      // stop() ran while the synthesis request was in flight — the
      // utterance is cancelled; stop() already dropped the queue and
      // released `busy`.
      if (gen !== this.generation) return;

      if (res?.ok && res.headers.get('content-type')?.startsWith('audio/')) {
        const blob = await res.blob();
        if (gen !== this.generation) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        this.activeAudio = audio;
        this.activeAudioUrl = url;
        audio.onended = () => {
          this.host.status = 'idle';
          this.teardownActiveAudio();
          this.drainNext();
        };
        audio.onerror = () => {
          this.host.status = 'idle';
          this.host.errorMessage = 'Audio playback failed.';
          this.teardownActiveAudio();
          this.drainNext();
        };
        this.host.status = 'speaking';
        try {
          await audio.play();
        } catch {
          // Autoplay was blocked (Safari, Firefox autoplay off, fresh
          // Chrome profile with no prior gesture). Stash the audio
          // and surface a scoped "click to resume" banner via
          // `host.autoplayBlocked`. The VoiceControl renders
          // the banner; clicking it calls resume(). We
          // deliberately do NOT register a document-wide click
          // handler — any click anywhere would otherwise trigger
          // stale audio at the wrong moment (Save buttons, tabs,
          // etc.). `busy` stays true: streamed chunks that arrive
          // while blocked queue behind this utterance and drain
          // after resume() (or are dropped by stop()).
          this.host.status = 'idle';
          // Hand ownership of the blob to the pending-autoplay slot.
          this.pendingAutoplayAudio = audio;
          this.pendingAutoplayUrl = url;
          this.activeAudio = null;
          this.activeAudioUrl = null;
          this.host.autoplayBlocked = true;
        }
        return;
      }

      if (res && !res.ok) {
        this.host.errorMessage = await this.extractSpeakError(res);
      } else if (res) {
        this.host.errorMessage = 'The selected text-to-speech provider returned no audio.';
      } else {
        this.host.errorMessage = 'The selected text-to-speech provider is unavailable.';
      }
      this.host.status = 'idle';
      this.drainNext();
      return;
    }

    if (engine !== 'browser' || !('speechSynthesis' in window)) {
      this.drainNext();
      return;
    }
    this.host.status = 'preparing';
    const utterance = new SpeechSynthesisUtterance(speakableText);
    // speechSynthesis.cancel() (from stop() or a later playOne) still
    // delivers onend/onerror for the cancelled utterance asynchronously —
    // the same generation check as the server path keeps a stale utterance
    // from pumping the queue under a newer one or flipping host.status.
    utterance.onstart = () => {
      if (gen !== this.generation) return;
      this.host.status = 'speaking';
    };
    utterance.onend = () => {
      if (gen !== this.generation) return;
      this.host.status = 'idle';
      this.drainNext();
    };
    utterance.onerror = () => {
      if (gen !== this.generation) return;
      this.host.status = 'idle';
      this.drainNext();
    };
    window.speechSynthesis.speak(utterance);
  }

  /**
   * Convert a non-OK synthesis response into a human-readable string.
   * Recognises the /voice pass-through's structured codes; any other 5xx
   * (a provider whose model is still loading) reads as "warming up".
   */
  private async extractSpeakError(res: Response): Promise<string> {
    let code: string | undefined;
    try {
      const data = (await res.clone().json()) as { error?: string; message?: string };
      if (typeof data.error === 'string') code = data.error;
    } catch {
      /* non-JSON body */
    }
    if (code === 'voice_unavailable') {
      return 'OpenPalm Voice is not enabled on this host.';
    }
    if (code === 'voice_unreachable' || res.status >= 500) {
      return 'Voice engine is warming up — try again in a moment.';
    }
    return `TTS failed (HTTP ${res.status}).`;
  }

  /** Cancel speech synthesis. Drops the entire queue. */
  stop(): void {
    this.speakQueue.length = 0;
    this.busy = false;
    this.generation += 1;
    this.overflowNoticed = false;
    this.teardownPendingAutoplay();
    this.teardownActiveAudio();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.host.status = 'idle';
  }
}
