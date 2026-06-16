export interface Provider {
  id: string;
  name: string;
  kind: 'cloud' | 'local' | 'hybrid';
  group: string;
  order: number;
  icon: string;
  desc: string;
  needsKey?: boolean;
  needsUrl?: boolean;
  optionalKey?: boolean;
  placeholder?: string;
  baseUrl: string;
  llmModel: string;
  embModel: string;
  embDims: number;
  canDetect?: boolean;
  keyPrefix?: string;
}

export interface ProviderState {
  selected: boolean;
  verified: boolean;
  verifying: boolean;
  error: boolean;
  errorMessage?: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
  ollamaMode: null | 'running' | 'instack';
  oauthPolling?: boolean;
  oauthUrl?: string;
  oauthInstructions?: string;
}

export interface ModelSelection {
  connId: string;
  model: string;
  dims?: number;
}

export interface DetectedProvider {
  provider: string;
  url: string;
  available: boolean;
}

export interface PortalCredential {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
}

export interface Portal {
  id: string;
  name: string;
  icon: string;
  desc: string;
  locked?: boolean;
  credentials?: PortalCredential[];
}

export interface PortalState {
  enabled: boolean;
  [key: string]: string | boolean;
}

export interface Service {
  id: string;
  name: string;
  icon: string;
  desc: string;
  recommended?: boolean;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  env?: string[];
  models?: Record<string, unknown>;
  localUrl?: string;
  authMethods?: AuthMethod[];
}

export interface AuthMethod {
  type: 'api' | 'oauth';
  label: string;
}

export interface ProviderGroup {
  id: string;
  label: string;
  desc: string;
}

export interface TtsOption {
  id: string;
  name: string;
  type: 'local' | 'cloud' | 'builtin' | 'skip';
  recommended?: boolean;
  desc: string;
}

export interface SttOption {
  id: string;
  name: string;
  type: 'local' | 'cloud' | 'builtin' | 'skip';
  recommended?: boolean;
  desc: string;
}

/**
 * Settings shape persisted alongside a TTS or STT engine selection.
 * Fields are optional; an engine that needs no extra config (browser, skip)
 * leaves them empty. Surfaced to the voice channel via OP_TTS_ / OP_STT_ env vars.
 */
export interface VoiceEngineValue {
  engine: string;
  /** Stable provider/runtime identifier — drives default base URL lookup. */
  provider?: string;
  /** Operator-supplied endpoint override. Wins over PROVIDER_DEFAULT_URLS. */
  baseURL?: string;
  model?: string;
  voice?: string;
  language?: string;
  /** Provider API key (e.g. ElevenLabs). Stored in the tts/stt payload block. */
  apiKey?: string;
}

/** A single configurable field for a voice engine. */
export interface VoiceEngineField {
  key: 'baseURL' | 'model' | 'voice' | 'language' | 'apiKey';
  label: string;
  /** When provided, render as a select. When omitted, render as a text input. */
  options?: string[];
  placeholder?: string;
  hint?: string;
}

export interface VoiceEngineConfig {
  /** Engine identifier matching TTS_OPTIONS / STT_OPTIONS. */
  id: string;
  /** Stable provider/runtime identifier used for default URL selection. */
  provider?: string;
  /** Fields the operator can configure for this engine. */
  fields: VoiceEngineField[];
}
