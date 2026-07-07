/**
 * Zero-dependency voice-activity detection for conversation mode's remote
 * (MediaRecorder + /api/transcribe) engine.
 *
 * The detector is RMS-energy hysteresis over an AnalyserNode sampled on a
 * fixed interval: speech starts after `startFrames` consecutive frames
 * above `threshold`, and ends after `endSilenceMs` of below-threshold
 * audio. The pure state machine (advanceVad / computeRms) is separated
 * from the thin WebAudio wiring so it can be unit-tested directly — and
 * so the whole detector can be replaced behind the same onSpeechStart /
 * onSpeechEnd interface by a proper VAD model later.
 *
 * Only access browser APIs (navigator, AudioContext) from startVad —
 * never at module top-level — for SSR safety.
 */

export interface VadConfig {
	/** Normalized RMS level (0..1) above which a frame counts as speech. */
	threshold: number;
	/** Consecutive above-threshold frames before speech starts. */
	startFrames: number;
	/** Below-threshold milliseconds before speech ends. */
	endSilenceMs: number;
	/** Milliseconds between analyser samples. */
	frameIntervalMs: number;
}

/**
 * Tuned for a close mic with echoCancellation/noiseSuppression on.
 * Open-speaker setups (assistant audible to the mic) may need `threshold`
 * raised so TTS playback doesn't trigger the detector; echoCancellation
 * makes typical laptop speaker+mic setups workable as-is.
 */
export const DEFAULT_VAD_CONFIG: VadConfig = {
	threshold: 0.02,
	startFrames: 3,
	endSilenceMs: 900,
	frameIntervalMs: 50,
};

/**
 * Ambient RMS frames collected before detection goes live (~1s at the
 * default 50ms frame interval). No speech events fire during this window.
 */
export const CALIBRATION_FRAMES = 20;

/**
 * Derive the effective speech threshold from ambient RMS samples collected
 * during the calibration window. Uses the 20th percentile of the samples as
 * the noise floor so a user who starts talking during calibration cannot
 * inflate it — loud speech frames land in the upper percentiles and are
 * ignored. The base threshold is a hard lower bound, so a very quiet room
 * never loosens the gate below the tuned default.
 */
export function calibrateThreshold(samples: number[], base: number): number {
	if (samples.length === 0) return base;
	const sorted = [...samples].sort((a, b) => a - b);
	const floor = sorted[Math.floor((sorted.length - 1) * 0.2)];
	return Math.max(base, floor * 2.75);
}

/**
 * Stricter gate applied while the assistant is speaking: 3x the effective
 * (calibrated) threshold and ~400ms of sustained speech (8 frames at 50ms)
 * before a start fires, so TTS bleed and brief noise cannot open a segment
 * mid-reply. End detection keeps the same silence window.
 */
export function deriveStrictVadConfig(base: VadConfig): VadConfig {
	return { ...base, threshold: base.threshold * 3, startFrames: 8 };
}

export interface VadTrackerState {
	speaking: boolean;
	/** Consecutive above-threshold frames observed while not speaking. */
	aboveCount: number;
	/** Accumulated below-threshold milliseconds while speaking. */
	silenceMs: number;
}

export type VadEvent = 'speech-start' | 'speech-end' | null;

export function initialVadState(): VadTrackerState {
	return { speaking: false, aboveCount: 0, silenceMs: 0 };
}

/**
 * Advance the hysteresis state machine by one sampled frame. Pure — the
 * caller owns the state and feeds one RMS level per frameIntervalMs.
 */
export function advanceVad(
	state: VadTrackerState,
	rms: number,
	config: VadConfig
): { state: VadTrackerState; event: VadEvent } {
	const above = rms >= config.threshold;
	if (!state.speaking) {
		const aboveCount = above ? state.aboveCount + 1 : 0;
		if (aboveCount >= config.startFrames) {
			return { state: { speaking: true, aboveCount: 0, silenceMs: 0 }, event: 'speech-start' };
		}
		return { state: { speaking: false, aboveCount, silenceMs: 0 }, event: null };
	}
	const silenceMs = above ? 0 : state.silenceMs + config.frameIntervalMs;
	if (silenceMs >= config.endSilenceMs) {
		return { state: { speaking: false, aboveCount: 0, silenceMs: 0 }, event: 'speech-end' };
	}
	return { state: { speaking: true, aboveCount: 0, silenceMs }, event: null };
}

/**
 * Normalized RMS (0..1) of a time-domain byte buffer as produced by
 * AnalyserNode.getByteTimeDomainData, where 128 is the zero crossing.
 */
export function computeRms(samples: Uint8Array): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		const deviation = (samples[i] - 128) / 128;
		sum += deviation * deviation;
	}
	return Math.sqrt(sum / samples.length);
}

export interface VadSession {
	/** The capture stream — callers record utterance segments from it. */
	stream: MediaStream;
	/** Stop sampling, close the AudioContext, and release the mic tracks. */
	stop: () => void;
}

/**
 * Open the mic and run the detector until stop(). echoCancellation and
 * noiseSuppression keep the assistant's own TTS playback (mostly) out of
 * the capture on laptop speaker+mic setups.
 */
export async function startVad(opts: {
	onSpeechStart: () => void;
	onSpeechEnd: () => void;
	/**
	 * Probed once per frame; while true the strict (while-speaking) config
	 * applies. A callback keeps this module free of store imports.
	 */
	isAssistantSpeaking?: () => boolean;
	config?: VadConfig;
}): Promise<VadSession> {
	if (typeof window === 'undefined' || !navigator?.mediaDevices?.getUserMedia) {
		throw new Error('Voice detection is not supported in this browser.');
	}
	const Ctor =
		(window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) {
		throw new Error('Voice detection is not supported in this browser.');
	}

	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true },
		});
	} catch (err) {
		const name = (err as { name?: string })?.name ?? '';
		if (name === 'NotAllowedError' || name === 'SecurityError') {
			throw new Error('Microphone access denied.', { cause: err });
		}
		throw new Error(`Microphone error: ${(err as Error)?.message ?? String(err)}`, { cause: err });
	}

	const baseConfig = opts.config ?? DEFAULT_VAD_CONFIG;
	const ctx = new Ctor();
	const source = ctx.createMediaStreamSource(stream);
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 1024;
	source.connect(analyser);

	const samples = new Uint8Array(analyser.fftSize);
	let state = initialVadState();
	// Noise-floor calibration: the first CALIBRATION_FRAMES frames only
	// collect ambient RMS — no detection runs — then the effective config
	// (and the strict while-speaking config derived from it) takes over.
	const calibrationSamples: number[] = [];
	let config = baseConfig;
	let strictConfig = deriveStrictVadConfig(baseConfig);
	let calibrated = false;
	const timer = setInterval(() => {
		analyser.getByteTimeDomainData(samples);
		const rms = computeRms(samples);
		if (!calibrated) {
			calibrationSamples.push(rms);
			if (calibrationSamples.length >= CALIBRATION_FRAMES) {
				config = {
					...baseConfig,
					threshold: calibrateThreshold(calibrationSamples, baseConfig.threshold),
				};
				strictConfig = deriveStrictVadConfig(config);
				calibrated = true;
			}
			return;
		}
		const active = opts.isAssistantSpeaking?.() ? strictConfig : config;
		const next = advanceVad(state, rms, active);
		state = next.state;
		if (next.event === 'speech-start') opts.onSpeechStart();
		else if (next.event === 'speech-end') opts.onSpeechEnd();
	}, baseConfig.frameIntervalMs);

	return {
		stream,
		stop(): void {
			clearInterval(timer);
			try {
				source.disconnect();
			} catch {
				/* already disconnected */
			}
			void ctx.close().catch(() => {
				/* already closed */
			});
			for (const track of stream.getTracks()) {
				try {
					track.stop();
				} catch {
					/* track already ended */
				}
			}
		},
	};
}
