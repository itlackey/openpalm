/**
 * Shared types and constants for the OpenPalm control plane.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type CoreServiceName =
  | "assistant"
  | "guardian";

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
  stashDir: string;      // homeDir/stash
  workspaceDir: string;  // homeDir/workspace
  cacheDir: string;      // homeDir/cache (regenerable/semi-persistent data)
  stateDir: string;      // homeDir/state (service data + system state)
  stackDir: string;      // configDir/stack (compose runtime + stack config)
  services: Record<string, "running" | "stopped">;
  artifacts: {
    compose: string;
  };
  artifactMeta: ArtifactMeta[];
  audit: AuditEntry[];
};

// ── Constants ──────────────────────────────────────────────────────────

// Scheduler is no longer a separate service — it runs as a co-process inside
// the assistant container. See core/assistant/entrypoint.sh.
// Memory has been replaced by the akm-cli stash (shared with assistant).
export const CORE_SERVICES: CoreServiceName[] = [
  "assistant",
  "guardian",
];

export const OPTIONAL_SERVICES: OptionalServiceName[] = [
  "admin",
  "docker-socket-proxy",
];
