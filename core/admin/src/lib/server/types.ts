/**
 * Shared types and constants for the OpenPalm control plane.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type CoreServiceName =
  | "assistant"
  | "guardian"
  | "memory"
  | "admin"
  | "caddy";

export type AccessScope = "host" | "lan";
export type CallerType = "assistant" | "cli" | "ui" | "system" | "test" | "unknown";

export type ConnectionKind =
  | "openai_compatible_remote"
  | "openai_compatible_local";

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
  setupToken: string;
  stateDir: string;
  configDir: string;
  dataDir: string;
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
  "caddy",
  "memory",
  "assistant",
  "guardian",
  "admin"
];

export const CONNECTION_KINDS: ConnectionKind[] = [
  "openai_compatible_remote",
  "openai_compatible_local",
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
