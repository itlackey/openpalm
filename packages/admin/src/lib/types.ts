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

export type SystemConnectionPayload = {
  provider: string;
  apiKey: string;
  baseUrl: string;
  systemModel: string;
  embeddingModel: string;
  embeddingDims: number;
  memoryUserId: string;
  customInstructions: string;
};

export type CanonicalConnectionProfileDto = {
  id: string;
  name: string;
  kind: 'openai_compatible_remote' | 'openai_compatible_local' | 'ollama_local';
  provider: string;
  baseUrl: string;
  auth: {
    mode: 'api_key' | 'none';
    apiKeySecretRef?: string;
  };
};

export type CanonicalAssignmentsDto = {
  llm: {
    connectionId: string;
    model: string;
    smallModel?: string;
  };
  embeddings: {
    connectionId: string;
    model: string;
    embeddingDims?: number;
  };
  reranking?: {
    enabled: boolean;
    connectionId?: string;
    mode?: 'llm' | 'dedicated';
    model?: string;
    topK?: number;
    topN?: number;
  };
  tts?: {
    enabled: boolean;
    connectionId?: string;
    model?: string;
    voice?: string;
    format?: string;
  };
  stt?: {
    enabled: boolean;
    connectionId?: string;
    model?: string;
    language?: string;
  };
};

export type ConnectionsResponseDto = {
  profiles: CanonicalConnectionProfileDto[];
  assignments: CanonicalAssignmentsDto;
  connections: Record<string, string>;
};

export type SaveConnectionsDtoPayload = {
  profiles: CanonicalConnectionProfileDto[];
  assignments: CanonicalAssignmentsDto;
  memoryModel?: string;
  memoryUserId?: string;
  customInstructions?: string;
  apiKey?: string;
  capabilities?: string[];
};

export type ConnectionProfilePayload = {
  id: string;
  name: string;
  kind: 'openai_compatible_remote' | 'openai_compatible_local';
  provider: string;
  baseUrl: string;
  auth:
    | {
        mode: 'none';
      }
    | {
        mode: 'api_key';
        apiKeySecretRef?: string | null;
      };
  /** Raw API key — stored in secrets.env, not in the profile document. */
  apiKey?: string;
};

export type ConnectionProfileMutationResponse = {
  ok: true;
  profile: CanonicalConnectionProfileDto;
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
