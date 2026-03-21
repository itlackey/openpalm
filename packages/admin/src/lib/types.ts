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

export type MemoryConfig = {
  mem0: {
    llm: { provider: string; config: Record<string, unknown> };
    embedder: { provider: string; config: Record<string, unknown> };
    vector_store: {
      provider: "qdrant";
      config: {
        collection_name: string;
        path: string;
        embedding_model_dims: number;
      };
    };
  };
  memory: { custom_instructions: string };
};

export type MemoryConfigResponse = {
  config: MemoryConfig;
  runtimeConfig: MemoryConfig | null;
  providers: { llm: string[]; embed: string[] };
  embeddingDims: Record<string, number>;
};

export type MemoryConfigSaveResult = {
  ok: boolean;
  persisted: boolean;
  pushed: boolean;
  pushError?: string;
  dimensionWarning?: string;
  dimensionMismatch?: boolean;
};

export type ConnectionsCapabilities = {
  llm: string;
  slm?: string;
  embeddings: { provider: string; model: string; dims: number };
  memory: { userId: string; customInstructions?: string };
};

export type ConnectionsResponseDto = {
  capabilities: ConnectionsCapabilities | null;
  secrets: Record<string, string>;
};

export type SaveConnectionsPayload = {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  systemModel?: string;
  embeddingModel?: string;
  embeddingDims?: number;
  memoryUserId?: string;
  customInstructions?: string;
};

export type SystemConnectionSaveResult = {
  ok: boolean;
  pushed: boolean;
  pushError?: string;
  dimensionWarning?: string;
  dimensionMismatch?: boolean;
};

export type RegistryComponentItem = {
  id: string;
  type: 'component';
};

export type RegistryAutomationItem = {
  name: string;
  type: 'automation';
  installed: boolean;
  description: string;
  schedule: string;
};

export type RegistryResponse = {
  components: RegistryComponentItem[];
  automations: RegistryAutomationItem[];
  source?: 'remote' | 'bundled';
};

export type InstanceStatus = 'running' | 'stopped' | 'error' | 'unknown';

// ── Component System DTOs (v0.10.0) ──────────────────────────────────

/** Component definition as returned by the API. */
export type ComponentResponse = {
  id: string;
  source: string;
  labels: {
    name: string;
    description: string;
    icon?: string;
    category?: string;
    docs?: string;
    healthcheck?: string;
  };
};

/** Instance summary as returned by list/create endpoints. */
export type InstanceResponse = {
  id: string;
  component: string;
  enabled: boolean;
  status: InstanceStatus;
  category?: string;
  instanceDir: string;
};

/** Request body for creating a new instance. */
export type CreateInstanceRequest = {
  component: string;
  name: string;
};

/** Request body for updating instance configuration. */
export type ConfigureInstanceRequest = {
  values: Record<string, string>;
};

/** Schema field definition as returned by the schema endpoint. */
export type EnvSchemaFieldResponse = {
  name: string;
  defaultValue: string;
  required: boolean;
  sensitive: boolean;
  helpText: string;
  section: string;
};

// ── OpenCode Provider/Model Types (Issue #350) ────────────────────────

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

export type DeviceAuthStartResponse = {
  pollToken: string;
  userCode: string;
  verificationUri: string;
  instructions?: string;
  method: 'auto' | 'code';
};

export type DeviceAuthPollEvent = {
  status: 'pending' | 'complete' | 'error';
  message: string;
};

export type ModelSetResponse = {
  ok: boolean;
  liveApplied: boolean;
  restartRequired: boolean;
  message: string;
};
