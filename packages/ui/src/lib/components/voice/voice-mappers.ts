/**
 * Pure mappers between the server's `/api/host/voice` config shape and the
 * VoiceTab form's simplified 3-engine model (openpalm-voice / remote /
 * browser). Extracted from VoiceTab.svelte so they can be unit-tested
 * without mounting the component.
 */

export type EngineId = 'openpalm-voice' | 'remote' | 'browser';

export type VoiceSection = {
  engine: EngineId | '';
  baseURL: string;
  model: string;
  voice: string; // tts only
  language: string; // stt only
};

export const EMPTY_SECTION = (): VoiceSection => ({
  engine: '',
  baseURL: '',
  model: '',
  voice: '',
  language: '',
});

export function normalizeEngine(raw: unknown, kind: 'tts' | 'stt'): EngineId | '' {
  if (typeof raw !== 'string') return '';
  if (raw === 'openpalm-voice') return 'openpalm-voice';
  if (raw === 'browser' || raw === (kind === 'tts' ? 'browser-tts' : 'browser-stt')) return 'browser';
  if (!raw || raw.startsWith('skip-')) return '';
  // Anything else (kokoro, openai-tts, whisper-local, openai-stt, …) is treated as remote.
  return 'remote';
}

export function readSection(
  raw: Record<string, unknown> | undefined,
  kind: 'tts' | 'stt',
): VoiceSection {
  const s = EMPTY_SECTION();
  if (!raw || typeof raw !== 'object') return s;
  s.engine = normalizeEngine(raw.engine, kind);
  if (typeof raw.baseURL === 'string') s.baseURL = raw.baseURL;
  if (typeof raw.model === 'string') s.model = raw.model;
  if (kind === 'tts' && typeof raw.voice === 'string') s.voice = raw.voice;
  if (kind === 'stt' && typeof raw.language === 'string') s.language = raw.language;
  return s;
}

export function buildPayload(
  section: VoiceSection,
  kind: 'tts' | 'stt',
): Record<string, unknown> | undefined {
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
