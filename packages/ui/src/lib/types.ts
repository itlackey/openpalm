import type { ToolStripEntry } from '$lib/chat/tool-strip.js';

export type HealthPayload = { status: string; service: string };

export type DockerContainer = {
  ID: string;
  Name: string;
  Names: string;
  Service: string;
  Image: string;
  State: string;
  Status: string;
  Health: string;
  Ports: string;
  Project: string;
  RunningFor: string;
  CreatedAt: string;
};

export type ContainerListResponse = {
  containers: Record<string, 'running' | 'stopped'>;
  dockerContainers: DockerContainer[] | null;
  dockerAvailable: boolean;
  /**
   * Services this stack actually deploys (compose model resolved with active
   * profiles). The Overview health summary measures THIS set, not `containers`
   * (the optimistic seed), so a service the stack never deploys is never
   * reported as a failed container.
   */
  managedServices: string[];
};

/** Unified display entry for the containers list */
export type ServiceEntry = {
  /** Unique ID for toggle — Docker container ID or service name */
  id: string;
  /** Compose service name */
  service: string;
  /** 'running' | 'stopped' | 'exited' | 'not created' etc. */
  state: string;
  /** Full Docker container data when available */
  docker: DockerContainer | null;
};

export type AutomationActionInfo = {
  type: 'api' | 'http' | 'shell' | 'assistant';
  method?: string;
  path?: string;
  url?: string;
  content?: string;
  agent?: string;
};

export type AutomationInfo = {
  name: string;
  description: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  action: AutomationActionInfo;
  on_failure: 'log' | 'audit';
  fileName: string;
};

export type AutomationsResponse = {
  automations: AutomationInfo[];
};

// ── OpenCode Provider/Model Types ──────────────────────────────────────

export type OpenCodeProviderSummary = {
  id: string;
  name: string;
  connected: boolean;
  env: string[];
  modelCount: number;
  models?: OpenCodeModelInfo[];
};

export type OpenCodeModelInfo = {
  id: string;
  name: string;
  family?: string;
  providerID: string;
  status?: string;
  capabilities?: Record<string, unknown>;
};

export type OpenCodeAuthMethod = {
  type: 'oauth' | 'api';
  label: string;
};

// ── Chat Types ──────────────────────────────────────────────────────────

// Messages route through `/proxy/assistant/...` only; the active OpenCode
// instance is chosen via the connection switcher.

export type ChatMessage = {
  id: string;
  type?: never;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
};

export type ChatDivider = {
  id: string;
  type: 'divider';
  label: string;
  timestamp: number;
};

export type ChatNote = {
  id: string;
  type: 'note';
  label: string;
  text: string;
  timestamp: number;
};

export type ChatToolEntry = {
  id: string;
  type: 'tool';
  toolState: ToolStripEntry;
  timestamp: number;
};

export type ChatEntry = ChatMessage | ChatDivider | ChatNote | ChatToolEntry;

export type OpenCodeMessageResponse = {
  parts: Array<{ type: string; text?: string }>;
};

export type ChatSessionState = {
  sessionId: string | null;
  status: 'idle' | 'connecting' | 'ready' | 'error';
  error: string;
};

// ── Per-endpoint session UX ─────────────────────────────────────────────
// See docs/technical/multi-endpoint-session-ux.md.

export type SessionSummary = {
  id: string;
  /** Empty until OpenCode summarizes; UI renders "Untitled" as fallback. */
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type EndpointChatState = {
  /** Sorted desc by `updatedAt`. */
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  sessionsLoading: boolean;
  sessionsError: string;
  activeSessionId: string | null;
};
