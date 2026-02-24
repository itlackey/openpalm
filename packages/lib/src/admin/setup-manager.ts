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
  serviceInstances: {
    openmemory: string;
    psql: string;
    qdrant: string;
  };
  smallModel: SmallModelConfig;
  profile: {
    name: string;
    email: string;
  };
  steps: {
    welcome: boolean;
    profile: boolean;
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
  serviceInstances: {
    openmemory: "",
    psql: "",
    qdrant: ""
  },
  smallModel: {
    endpoint: "",
    modelId: ""
  },
  profile: {
    name: "",
    email: ""
  },
  steps: {
    welcome: false,
    profile: false,
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

function isValidSetupState(value: unknown): value is SetupState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.completed === "boolean" &&
    typeof v.accessScope === "string" &&
    ["host", "lan", "public"].includes(v.accessScope as string) &&
    typeof v.serviceInstances === "object" && v.serviceInstances !== null &&
    typeof v.smallModel === "object" && v.smallModel !== null &&
    typeof v.profile === "object" && v.profile !== null &&
    typeof v.steps === "object" && v.steps !== null &&
    Array.isArray(v.enabledChannels) &&
    Array.isArray(v.installedExtensions)
  );
}

export class SetupManager {
  private path: string;

  constructor(dataDir: string) {
    this.path = `${dataDir}/setup-state.json`;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  getState(): SetupState {
    if (!existsSync(this.path)) return structuredClone(DEFAULT_STATE);
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (!isValidSetupState(parsed)) return structuredClone(DEFAULT_STATE);
      return parsed;
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  save(state: SetupState) {
    mkdirSync(dirname(this.path), { recursive: true });
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

  setProfile(profile: Partial<SetupState["profile"]>) {
    const state = this.getState();
    state.profile = {
      ...state.profile,
      ...profile
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
    state.enabledChannels = [...new Set(channels)];
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
