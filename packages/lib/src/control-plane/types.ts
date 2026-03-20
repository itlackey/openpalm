/**
 * Shared types and constants for the OpenPalm control plane.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type CoreServiceName =
  | "assistant"
  | "guardian"
  | "memory"
  | "scheduler";

export type OptionalServiceName = "admin" | "caddy" | "docker-socket-proxy";

export type AccessScope = "host" | "lan";
export type CallerType = "assistant" | "cli" | "ui" | "system" | "test" | "unknown";

export type ConnectionKind =
  | "openai_compatible_remote"
  | "openai_compatible_local"
  | "ollama_local";

export type ConnectionAuthMode = "api_key" | "none";

export type CanonicalConnectionProfile = {
  id: string;
  name: string;
  kind: ConnectionKind;
  provider: string;
  baseUrl: string;
  auth: {
    mode: ConnectionAuthMode;
    apiKeySecretRef?: string;
  };
};

export type RequiredCapability = "llm" | "embeddings";
export type OptionalCapability = "reranking" | "tts" | "stt";
export type Capability = RequiredCapability | OptionalCapability;

export type LlmAssignment = {
  connectionId: string;
  model: string;
  smallModel?: string;
};

export type EmbeddingsAssignment = {
  connectionId: string;
  model: string;
  embeddingDims?: number;
};

export type RerankerAssignment = {
  enabled: boolean;
  connectionId?: string;
  mode?: "llm" | "dedicated";
  model?: string;
  topK?: number;
  topN?: number;
};

export type TtsAssignment = {
  enabled: boolean;
  connectionId?: string;
  model?: string;
  voice?: string;
  format?: string;
};

export type SttAssignment = {
  enabled: boolean;
  connectionId?: string;
  model?: string;
  language?: string;
};

export type CapabilityAssignments = {
  llm: LlmAssignment;
  embeddings: EmbeddingsAssignment;
  reranking?: RerankerAssignment;
  tts?: TtsAssignment;
  stt?: SttAssignment;
};

export type CanonicalConnectionsDocument = {
  version: 1;
  profiles: CanonicalConnectionProfile[];
  assignments: CapabilityAssignments;
};

/** Info about a discovered channel */
export type ChannelInfo = {
  name: string;
  hasRoute: boolean;
  ymlPath: string;
  caddyPath: string | null;
};

export type AuditEntry = {
  at: string;
  requestId: string;
  actor: string;
  callerType: CallerType;
  action: string;
  args: Record<string, unknown>;
  ok: boolean;
};

export type ArtifactMeta = {
  name: string;
  sha256: string;
  generatedAt: string;
  bytes: number;
};

export type ControlPlaneState = {
  adminToken: string;
  assistantToken: string;
  setupToken: string;
  homeDir: string;
  configDir: string;
  vaultDir: string;
  dataDir: string;
  logsDir: string;
  cacheDir: string;
  services: Record<string, "running" | "stopped">;
  artifacts: {
    compose: string;
    caddyfile: string;
  };
  artifactMeta: ArtifactMeta[];
  audit: AuditEntry[];
  channelSecrets: Record<string, string>;
};

// ── Constants ──────────────────────────────────────────────────────────

export const CORE_SERVICES: CoreServiceName[] = [
  "memory",
  "assistant",
  "guardian",
  "scheduler",
];

export const OPTIONAL_SERVICES: OptionalServiceName[] = [
  "caddy",
  "admin",
  "docker-socket-proxy",
];

export const CONNECTION_KINDS: ConnectionKind[] = [
  "openai_compatible_remote",
  "openai_compatible_local",
  "ollama_local",
];

export const REQUIRED_CAPABILITIES: RequiredCapability[] = [
  "llm",
  "embeddings",
];

export const OPTIONAL_CAPABILITIES: OptionalCapability[] = [
  "reranking",
  "tts",
  "stt",
];

export const MAX_AUDIT_MEMORY = 1000;
