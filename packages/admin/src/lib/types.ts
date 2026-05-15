export type HealthPayload = { status: string; service: string };

export type AdminOpenCodeStatusResponse = {
  status: 'ready' | 'unavailable';
  url: string;
};

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

export type CatalogAutomation = {
  name: string;
  type: 'automation';
  installed: boolean;
  description: string;
  schedule: string;
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


