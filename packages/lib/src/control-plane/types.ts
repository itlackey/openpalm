/**
 * Shared types and constants for the OpenPalm control plane.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type CoreServiceName =
  | "assistant"
  | "guardian"
  | "memory"
  | "scheduler";

export type OptionalServiceName = "admin" | "docker-socket-proxy";

export type AccessScope = "host" | "lan";
export type CallerType = "assistant" | "cli" | "ui" | "system" | "test" | "unknown";

/** Info about a discovered channel */
export type ChannelInfo = {
  name: string;
  ymlPath: string;
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
  };
  artifactMeta: ArtifactMeta[];
  audit: AuditEntry[];
};

// ── Constants ──────────────────────────────────────────────────────────

export const CORE_SERVICES: CoreServiceName[] = [
  "memory",
  "assistant",
  "guardian",
  "scheduler",
];

export const OPTIONAL_SERVICES: OptionalServiceName[] = [
  "admin",
  "docker-socket-proxy",
];

export const MAX_AUDIT_MEMORY = 1000;
