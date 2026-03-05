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

export type AutomationActionInfo = {
  type: 'api' | 'http' | 'shell' | 'assistant';
  method?: string;
  path?: string;
  url?: string;
  content?: string;
  agent?: string;
};

export type AutomationLogEntry = {
  at: string;
  ok: boolean;
  durationMs: number;
  error?: string;
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
  logs: AutomationLogEntry[];
};

export type SchedulerStatus = {
  jobCount: number;
  jobs: { name: string; fileName: string; schedule: string; running: boolean }[];
};

export type AutomationsResponse = {
  automations: AutomationInfo[];
  scheduler: SchedulerStatus;
};

export type ChannelInfo = {
  name: string;
  hasRoute: boolean;
  service: string;
  status: string;
};

export type ChannelsResponse = {
  installed: ChannelInfo[];
  available: { name: string; hasRoute: boolean }[];
};

export type OpenMemoryConfig = {
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
  openmemory: { custom_instructions: string };
};

export type OpenMemoryConfigResponse = {
  config: OpenMemoryConfig;
  runtimeConfig: OpenMemoryConfig | null;
  providers: { llm: string[]; embed: string[] };
  embeddingDims: Record<string, number>;
};

export type OpenMemoryConfigSaveResult = {
  ok: boolean;
  persisted: boolean;
  pushed: boolean;
  pushError?: string;
  dimensionWarning?: string;
  dimensionMismatch?: boolean;
};

export type SystemConnectionPayload = {
  provider: string;
  apiKey: string;
  baseUrl: string;
  systemModel: string;
  embeddingModel: string;
  embeddingDims: number;
  openmemoryUserId: string;
  customInstructions: string;
};

export type SystemConnectionSaveResult = {
  ok: boolean;
  pushed: boolean;
  pushError?: string;
  dimensionWarning?: string;
  dimensionMismatch?: boolean;
};

export type RegistryChannelItem = {
  name: string;
  type: 'channel';
  installed: boolean;
  hasRoute: boolean;
  description: string;
};

export type RegistryAutomationItem = {
  name: string;
  type: 'automation';
  installed: boolean;
  description: string;
  schedule: string;
};

export type RegistryResponse = {
  channels: RegistryChannelItem[];
  automations: RegistryAutomationItem[];
  source?: 'remote' | 'bundled';
};