/**
 * Shared types and constants for the OpenPalm control plane.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type CoreServiceName =
  | "assistant"
  | "guardian"
  | "openmemory"
  | "openmemory-ui"
  | "admin"
  | "caddy"
  | "postgres"
  | "qdrant";

export type AccessScope = "host" | "lan";
export type CallerType = "assistant" | "cli" | "ui" | "system" | "test" | "unknown";

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
  postgresPassword: string;
  stateDir: string;
  configDir: string;
  dataDir: string;
  services: Record<string, "running" | "stopped">;
  installedExtensions: Set<string>;
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
  "postgres",
  "qdrant",
  "openmemory",
  "openmemory-ui",
  "assistant",
  "guardian",
  "admin"
];

export const MAX_AUDIT_MEMORY = 1000;
