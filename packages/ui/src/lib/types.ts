import type { ToolStripEntry } from '$lib/chat/tool-strip.js';

// The legacy FeatureFlags { admin } alias was deleted in Phase 4: nothing read it anymore — capability checks
// live in computeServerRuntimeContext/resolveCapabilities + hasCapability().

// ── RuntimeContext v2 (issue #509) ──────────────────────────

export type Capability =
  | 'chat'
  | 'connections:read'
  | 'connections:manage'
  | 'connections:switch'
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
  /**
   * True when this process is admin-capable — running inside Electron
   * (OP_INSIDE_ELECTRON=1) or explicitly opted in (OP_ENABLE_ADMIN=1, e.g.
   * `openpalm admin`). Admin capability is an Electron-or-CLI-only security
   * boundary: a served/container build can never self-grant it (there is no
   * env-based self-grant footgun anymore).
   */
  admin: boolean;
  serverCapabilities: Capability[];
  publicBaseUrl: string;
  uiVersion: string;
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
    csrfMode: 'loopback-origin' | 'same-site';
  };
  /**
   * Advertised when this process can serve the local voice container: the
   * same-origin base path of the transparent /voice pass-through (session-
   * authed, OpenAI-compatible surface). Clients use it to offer/auto-select
   * the "OpenPalm Voice" speech provider.
   */
  voice?: { url: string };
};

export type ClientDisplayMode = 'electron' | 'standalone-pwa' | 'browser';

export type ActiveConnectionContext = {
  id: string;
  /** Server-verified at connection-add time — never self-granted. */
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

export type AutomationInfo = {
  taskId: string;
  fileName: string;
  size: number;
  revision: string;
  schedulable: boolean;
};

export type AutomationsResponse = {
  automations: AutomationInfo[];
};

export type AutomationRunResult = {
  ok: boolean;
  fileName: string;
  status: 'completed' | 'blocked' | 'failed' | 'disabled' | 'active';
  error: string | null;
};

// ── OpenCode Provider/Model Types ──────────────────────────────────────

export type OpenCodeModelInfo = {
  id: string;
  name: string;
  family?: string;
  providerID: string;
  status?: string;
  capabilities?: Record<string, unknown>;
};

// ── Chat Types ──────────────────────────────────────────────────────────

// Messages route directly to the active connection's OpenCode instance,
// chosen browser-side via the connection switcher.

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
