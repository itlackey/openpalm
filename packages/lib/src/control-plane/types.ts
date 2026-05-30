/**
 * Shared types and constants for the OpenPalm control plane.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type CoreServiceName =
  | "assistant"
  | "guardian";

export type AccessScope = "host" | "lan";
export type CallerType = "assistant" | "cli" | "ui" | "system" | "test" | "unknown";

/** Info about a discovered channel */
export type ChannelInfo = {
  name: string;
  ymlPath: string;
};

export type ArtifactMeta = {
  name: string;
  sha256: string;
  generatedAt: string;
  bytes: number;
};

export type ControlPlaneState = {
  homeDir: string;
  configDir: string;
  stashDir: string;      // homeDir/knowledge
  workspaceDir: string;  // homeDir/workspace
  dataDir: string;       // homeDir/data (service data + operational files)
  stackDir: string;      // configDir/stack (compose runtime + stack config)
  services: Record<string, "running" | "stopped">;
  artifacts: {
    compose: string;
  };
  artifactMeta: ArtifactMeta[];
};

// ── Constants ──────────────────────────────────────────────────────────

// Scheduler is no longer a separate service — it runs as a co-process inside
// the assistant container. See core/assistant/entrypoint.sh.
// Memory has been replaced by the akm-cli stash (shared with assistant).
export const CORE_SERVICES: CoreServiceName[] = [
  "assistant",
  "guardian",
];
