import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SmallModelConfig = {
  endpoint: string;
  modelId: string;
};

export type SetupState = {
  completed: boolean;
  completedAt?: string;
  accessScope: "host" | "lan" | "public";
  caddyEmail: string;
  serviceInstances: {
    openmemory: string;
    psql: string;
    qdrant: string;
  };
  smallModel: SmallModelConfig;
  steps: {
    welcome: boolean;
    accessScope: boolean;
    serviceInstances: boolean;
    healthCheck: boolean;
    security: boolean;
    channels: boolean;
    extensions: boolean;
  };
  enabledChannels: string[];
  installedExtensions: string[];
};

const DEFAULT_STATE: SetupState = {
  completed: false,
  accessScope: "host",
  caddyEmail: "",
  serviceInstances: {
    openmemory: "",
    psql: "",
    qdrant: ""
  },
  smallModel: {
    endpoint: "",
    modelId: ""
  },
  steps: {
    welcome: false,
    accessScope: false,
    serviceInstances: false,
    healthCheck: false,
    security: false,
    channels: false,
    extensions: false
  },
  enabledChannels: [],
  installedExtensions: []
};

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sanitizeServiceInstances(value: unknown): SetupState["serviceInstances"] {
  const source = (value && typeof value === "object") ? value as Partial<SetupState["serviceInstances"]> : {};
  return {
    openmemory: typeof source.openmemory === "string" ? source.openmemory : "",
    psql: typeof source.psql === "string" ? source.psql : "",
    qdrant: typeof source.qdrant === "string" ? source.qdrant : "",
  };
}

function sanitizeSmallModel(value: unknown): SmallModelConfig {
  const source = (value && typeof value === "object") ? value as Partial<SmallModelConfig> : {};
  return {
    endpoint: typeof source.endpoint === "string" ? source.endpoint : "",
    modelId: typeof source.modelId === "string" ? source.modelId : "",
  };
}

function sanitizeSteps(value: unknown): SetupState["steps"] {
  const source = (value && typeof value === "object") ? value as Partial<SetupState["steps"]> : {};
  return {
    welcome: source.welcome === true,
    accessScope: source.accessScope === true,
    serviceInstances: source.serviceInstances === true,
    healthCheck: source.healthCheck === true,
    security: source.security === true,
    channels: source.channels === true,
    extensions: source.extensions === true,
  };
}

function normalizeState(parsed: Partial<SetupState>): SetupState {
  const accessScope = parsed.accessScope === "lan" ? "lan" : "host";
  return {
    completed: parsed.completed === true,
    completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
    accessScope,
    caddyEmail: typeof parsed.caddyEmail === "string" ? parsed.caddyEmail : "",
    serviceInstances: sanitizeServiceInstances(parsed.serviceInstances),
    smallModel: sanitizeSmallModel(parsed.smallModel),
    steps: sanitizeSteps(parsed.steps),
    enabledChannels: sanitizeStringArray(parsed.enabledChannels),
    installedExtensions: sanitizeStringArray(parsed.installedExtensions),
  };
}

export class SetupManager {
  private path: string;

  constructor(dataDir: string) {
    this.path = `${dataDir}/setup-state.json`;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  getState(): SetupState {
    if (!existsSync(this.path)) return { ...DEFAULT_STATE, steps: { ...DEFAULT_STATE.steps } };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SetupState>;
      return normalizeState(parsed);
    } catch {
      return { ...DEFAULT_STATE, steps: { ...DEFAULT_STATE.steps }, serviceInstances: { ...DEFAULT_STATE.serviceInstances }, smallModel: { ...DEFAULT_STATE.smallModel } };
    }
  }

  save(state: SetupState) {
    writeFileSync(this.path, JSON.stringify(state, null, 2), "utf8");
  }

  completeStep(step: keyof SetupState["steps"]) {
    const state = this.getState();
    state.steps[step] = true;
    this.save(state);
    return state;
  }

  setAccessScope(scope: "host" | "lan" | "public") {
    const state = this.getState();
    state.accessScope = scope;
    this.save(state);
    return state;
  }

  setCaddyEmail(email: string) {
    const state = this.getState();
    state.caddyEmail = email;
    this.save(state);
    return state;
  }

  setServiceInstances(serviceInstances: Partial<SetupState["serviceInstances"]>) {
    const state = this.getState();
    state.serviceInstances = {
      ...state.serviceInstances,
      ...serviceInstances
    };
    this.save(state);
    return state;
  }

  setSmallModel(smallModel: Partial<SmallModelConfig>) {
    const state = this.getState();
    state.smallModel = {
      ...state.smallModel,
      ...smallModel
    };
    this.save(state);
    return state;
  }

  completeSetup() {
    const state = this.getState();
    state.completed = true;
    state.completedAt = new Date().toISOString();
    this.save(state);
    return state;
  }

  addChannel(channel: string) {
    const state = this.getState();
    if (!state.enabledChannels.includes(channel)) state.enabledChannels.push(channel);
    this.save(state);
    return state;
  }

  setEnabledChannels(channels: string[]) {
    const state = this.getState();
    state.enabledChannels = uniqueStrings(channels);
    this.save(state);
    return state;
  }

  addExtension(extensionId: string) {
    const state = this.getState();
    if (!state.installedExtensions.includes(extensionId)) {
      state.installedExtensions.push(extensionId);
    }
    this.save(state);
    return state;
  }

  isFirstBoot(): boolean {
    return !existsSync(this.path);
  }
}
