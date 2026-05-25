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

// Phase 4 of the auth/proxy refactor deleted the assistant/admin chat
// backend toggle. Messages route through `/proxy/assistant/...` only;
// the active OpenCode instance is chosen via the connection switcher.

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

export type ChatEntry = ChatMessage | ChatDivider;

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

