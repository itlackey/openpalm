import type { ToolStripEntry } from '$lib/chat/tool-strip.js';

// The legacy FeatureFlags { admin } alias was deleted in Phase 4 (plan
// ui-runtime-modes-plan.md §6.4): nothing read it anymore — capability checks
// live in computeServerRuntimeContext/resolveCapabilities + hasCapability().

// ── RuntimeContext v2 (plan §6.1, issue #509) ──────────────────────────

export type UiHostMode =
  | 'electron-host'
  | 'host-ui'
  | 'assistant-container'
  | 'pwa-static';

export type Capability =
  | 'chat'
  | 'connections:read'
  | 'connections:manage'
  | 'connections:switch'
  | 'connections:single'
  | 'assistant-settings:read'
  | 'assistant-settings:write'
  | 'host:setup'
  | 'host:stack:read'
  | 'host:stack:write'
  | 'host:containers'
  | 'host:addons'
  | 'host:updates'
  | 'host:logs'
  | 'host:secrets'
  | 'host:recovery'
  | 'host:akm-sharing'
  | 'pwa:install';

export type ServerRuntimeContext = {
  /** Contract version — the /api/runtime handshake for remote/hosted clients. */
  version: 2;
  hostMode: UiHostMode;
  serverCapabilities: Capability[];
  publicBaseUrl: string;
  uiVersion: string;
  skeletonVersion: string;
  activeConnectionMode: 'single' | 'multi';
  routes: {
    chat?: string;
    connections?: string;
    assistantSettings?: string;
    host?: string;
    setup?: string;
  };
  security: {
    hostAdminLoopbackOnly: boolean;
    requiresHttpsForRemoteConnections: boolean;
    csrfMode: 'loopback-origin' | 'same-site' | 'bearer-token';
  };
};

export type ClientDisplayMode = 'electron' | 'standalone-pwa' | 'browser';

/** Connection kinds (plan §6.6). `endpoints.json` is not renamed; the
 *  internal model uses "connection" language. */
export type ConnectionKind = 'local-opencode' | 'remote-opencode' | 'openpalm-client-api';

export type ActiveConnectionContext = {
  kind: ConnectionKind;
  id: string;
  /** Server-verified at connection-add time (plan §8.9) — never self-granted. */
  grantedCapabilities?: Capability[];
};

export type ClientContext = {
  displayMode: ClientDisplayMode;
  activeConnection?: ActiveConnectionContext;
};

export type RuntimeContext = ServerRuntimeContext & {
  clientContext: ClientContext;
  effectiveCapabilities: Capability[];
};

export type { ToolStripEntry };

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
  type: 'api' | 'http' | 'shell' | 'assistant' | 'workflow';
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
  /** Tool activity attached to an assistant turn. Shown as a compact strip below the text. */
  toolStates?: ToolStripEntry[];
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

/**
 * Orphan tool group: tool activity with no following assistant text in the
 * same OpenCode message. Rendered as a single grouped strip, never as N
 * separate bubbles.
 */
export type ChatToolGroup = {
  id: string;
  type: 'tool-group';
  toolStates: ToolStripEntry[];
  timestamp: number;
};

export type ChatEntry = ChatMessage | ChatDivider | ChatNote | ChatToolGroup;

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
