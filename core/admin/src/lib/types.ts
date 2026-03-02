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
  type: 'api' | 'http' | 'shell';
  method?: string;
  path?: string;
  url?: string;
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
};
