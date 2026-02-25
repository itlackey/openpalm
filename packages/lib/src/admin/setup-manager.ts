import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ensureStackSpec, stringifyStackSpec } from "./stack-spec.ts";

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

export const DEFAULT_STATE: SetupState = {
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
  private stackSpecPath?: string;

  constructor(dataDir: string, options?: { stackSpecPath?: string }) {
    this.path = `${dataDir}/setup-state.json`;
    this.stackSpecPath = options?.stackSpecPath;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  getState(): SetupState {
    if (!existsSync(this.path)) return this.withStackSpecState(structuredClone(DEFAULT_STATE));
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (!isValidSetupState(parsed)) return this.withStackSpecState(structuredClone(DEFAULT_STATE));
      return this.withStackSpecState(parsed);
    } catch {
      return this.withStackSpecState(structuredClone(DEFAULT_STATE));
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
    this.withMutableStackSpec((spec) => {
      spec.accessScope = scope;
    });
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
    const enabled = new Set(channels);
    this.withMutableStackSpec((spec) => {
      for (const [name, channel] of Object.entries(spec.channels)) {
        channel.enabled = enabled.has(name);
      }
    });
    const state = this.getState();
    state.enabledChannels = [...enabled];
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

  private withStackSpecState(state: SetupState): SetupState {
    if (!this.stackSpecPath) return state;
    try {
      const spec = ensureStackSpec(this.stackSpecPath);
      state.accessScope = spec.accessScope;
      state.enabledChannels = Object.entries(spec.channels)
        .filter(([, config]) => config.enabled)
        .map(([name]) => name)
        .sort();
    } catch {
      // Best-effort sync only; fall back to setup-state values.
    }
    return state;
  }

  private withMutableStackSpec(mutator: (spec: ReturnType<typeof ensureStackSpec>) => void): void {
    if (!this.stackSpecPath) return;
    try {
      const spec = ensureStackSpec(this.stackSpecPath);
      mutator(spec);
      writeFileSync(this.stackSpecPath, stringifyStackSpec(spec), "utf8");
    } catch {
      // Best-effort sync only; setup state remains writable.
    }
  }
}
