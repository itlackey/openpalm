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

export interface ChannelCredential {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
}

export interface Channel {
  id: string;
  name: string;
  icon: string;
  desc: string;
  locked?: boolean;
  credentials?: ChannelCredential[];
}

export interface ChannelState {
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

export interface RerankingOptions {
  enabled: boolean;
  mode: 'llm' | 'dedicated';
  model: string;
  topK: number;
  topN: number;
}
