/**
 * Browser MediaRecorder wrapper. Streams microphone audio into a single
 * Blob that the caller can POST to /api/transcribe.
 *
 * All browser API access is intentionally lazy — this module is safe to
 * import in SSR contexts; the throws happen only at startRecording().
 */

export type RecordingSession = {
	/** Stop recording, await the final blob. */
	stop: () => Promise<Blob>;
	/** Cancel without yielding a blob (e.g. on auth error). */
	cancel: () => void;
};

const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm'];

function pickMimeType(): string | undefined {
	const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
	if (!MR || typeof MR.isTypeSupported !== 'function') return undefined;
	for (const t of PREFERRED_MIME_TYPES) {
		if (MR.isTypeSupported(t)) return t;
	}
	return undefined;
}

export async function startRecording(): Promise<RecordingSession> {
	if (typeof window === 'undefined') {
		throw new Error('Recording is only available in the browser.');
	}
	if (typeof MediaRecorder === 'undefined') {
		throw new Error('Recording is not supported in this browser.');
	}
	if (!navigator?.mediaDevices?.getUserMedia) {
		throw new Error('Recording is not supported in this browser.');
	}

	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (err) {
		const name = (err as { name?: string })?.name ?? '';
		if (name === 'NotAllowedError' || name === 'SecurityError') {
			throw new Error('Microphone access denied. Open System Settings → Privacy & Security → Microphone and enable OpenPalm, then restart the app.', { cause: err });
		}
		if (name === 'NotFoundError' || name === 'OverconstrainedError') {
			throw new Error('No microphone was found. Plug in a microphone and try again.', { cause: err });
		}
		throw new Error(`Microphone error: ${(err as Error)?.message ?? String(err)}`, { cause: err });
	}

	return createRecorderSession(stream, true);
}

/**
 * Record from an existing MediaStream. Conversation mode records many
 * short utterance segments from one long-lived capture stream, so the
 * caller owns the stream — stop()/cancel() end the recorder but leave
 * the tracks live.
 */
export function recordFromStream(stream: MediaStream): RecordingSession {
	if (typeof MediaRecorder === 'undefined') {
		throw new Error('Recording is not supported in this browser.');
	}
	return createRecorderSession(stream, false);
}

function createRecorderSession(stream: MediaStream, ownsStream: boolean): RecordingSession {
	const mimeType = pickMimeType();
	const recorder: MediaRecorder = mimeType
		? new MediaRecorder(stream, { mimeType })
		: new MediaRecorder(stream);

	const chunks: Blob[] = [];
	recorder.addEventListener('dataavailable', (ev) => {
		const data = (ev as BlobEvent).data;
		if (data && data.size > 0) chunks.push(data);
	});

	let stopped = false;
	let cancelled = false;
	let stopResolve: ((blob: Blob) => void) | null = null;
	let stopReject: ((err: Error) => void) | null = null;

	function releaseTracks(): void {
		if (!ownsStream) return;
		for (const track of stream.getTracks()) {
			try {
				track.stop();
			} catch {
				/* track already ended */
			}
		}
	}

	recorder.addEventListener('stop', () => {
		releaseTracks();
		if (cancelled) return;
		const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
		stopResolve?.(blob);
	});

	recorder.addEventListener('error', (ev) => {
		releaseTracks();
		const err = (ev as unknown as { error?: Error })?.error ?? new Error('Recorder error');
		stopReject?.(err);
	});

	recorder.start();

	return {
		stop(): Promise<Blob> {
			if (stopped) return Promise.reject(new Error('Recorder already stopped'));
			stopped = true;
			return new Promise<Blob>((resolve, reject) => {
				stopResolve = resolve;
				stopReject = reject;
				try {
					if (recorder.state !== 'inactive') recorder.stop();
				} catch (err) {
					releaseTracks();
					reject(err as Error);
				}
			});
		},
		cancel(): void {
			if (stopped) return;
			stopped = true;
			cancelled = true;
			try {
				if (recorder.state !== 'inactive') recorder.stop();
			} catch {
				/* already stopped */
			}
			releaseTracks();
		},
	};
}
