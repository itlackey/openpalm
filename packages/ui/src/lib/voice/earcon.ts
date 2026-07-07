/**
 * Earcon feedback — a short two-tone blip acknowledging a sent message,
 * replacing the old spoken ack phrases. Pure WebAudio: no asset files and
 * no TTS engine required, so the ack works wherever audio output exists.
 *
 * playAck runs inside the send-click user gesture, which also primes the
 * browser's autoplay policy for the TTS audio that follows.
 *
 * Only access browser APIs (window, AudioContext) from playAck — never at
 * module top level — for SSR safety.
 */

// One lazily-created context reused for every ack — contexts are a limited
// browser resource and the earcon fires on every send.
let ctx: AudioContext | null = null;

/** One sine tone with a fast-attack / fast-decay gain envelope. */
function tone(context: AudioContext, frequency: number, startAt: number, durationS: number): void {
	const osc = context.createOscillator();
	const gain = context.createGain();
	osc.type = 'sine';
	osc.frequency.value = frequency;
	gain.gain.setValueAtTime(0, startAt);
	gain.gain.linearRampToValueAtTime(0.08, startAt + 0.005);
	gain.gain.linearRampToValueAtTime(0, startAt + durationS);
	osc.connect(gain);
	gain.connect(context.destination);
	osc.start(startAt);
	osc.stop(startAt + durationS + 0.01);
}

/**
 * Play the "message sent" ack: two quick ascending sine tones, total under
 * 200ms. All failures are swallowed — the ack is best-effort feedback and
 * must never surface an error or block the send path.
 */
export function playAck(): void {
	if (typeof window === 'undefined') return;
	try {
		if (!ctx) {
			const Ctor =
				(window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
				(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!Ctor) return;
			ctx = new Ctor();
		}
		if (ctx.state === 'suspended') {
			void ctx.resume().catch(() => {
				/* still suspended — the tones just won't sound this time */
			});
		}
		const now = ctx.currentTime;
		tone(ctx, 880, now, 0.06);
		tone(ctx, 1320, now + 0.07, 0.08);
	} catch {
		/* audio unavailable — silently skip the ack */
	}
}
