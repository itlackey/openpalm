import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { e as ensureStackSpec, s as stringifyStackSpec } from './stack-spec-DIyG4On0.js';
import './index-CyXiysyI.js';

const DEFAULT_STATE = {
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
function isValidSetupState(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return typeof v.completed === "boolean" && typeof v.accessScope === "string" && ["host", "lan", "public"].includes(v.accessScope) && typeof v.serviceInstances === "object" && v.serviceInstances !== null && typeof v.smallModel === "object" && v.smallModel !== null && typeof v.profile === "object" && v.profile !== null && typeof v.steps === "object" && v.steps !== null && Array.isArray(v.enabledChannels) && Array.isArray(v.installedExtensions);
}
class SetupManager {
  path;
  stackSpecPath;
  constructor(dataDir, options) {
    this.path = `${dataDir}/setup-state.json`;
    this.stackSpecPath = options?.stackSpecPath;
    mkdirSync(dirname(this.path), { recursive: true });
  }
  getState() {
    if (!existsSync(this.path)) return this.withStackSpecState(structuredClone(DEFAULT_STATE));
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (!isValidSetupState(parsed)) return this.withStackSpecState(structuredClone(DEFAULT_STATE));
      return this.withStackSpecState(parsed);
    } catch {
      return this.withStackSpecState(structuredClone(DEFAULT_STATE));
    }
  }
  save(state) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2), "utf8");
  }
  completeStep(step) {
    const state = this.getState();
    state.steps[step] = true;
    this.save(state);
    return state;
  }
  setAccessScope(scope) {
    this.withMutableStackSpec((spec) => {
      spec.accessScope = scope;
    });
    const state = this.getState();
    state.accessScope = scope;
    this.save(state);
    return state;
  }
  setServiceInstances(serviceInstances) {
    const state = this.getState();
    state.serviceInstances = {
      ...state.serviceInstances,
      ...serviceInstances
    };
    this.save(state);
    return state;
  }
  setSmallModel(smallModel) {
    const state = this.getState();
    state.smallModel = {
      ...state.smallModel,
      ...smallModel
    };
    this.save(state);
    return state;
  }
  setProfile(profile) {
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
    state.completedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.save(state);
    return state;
  }
  addChannel(channel) {
    const state = this.getState();
    if (!state.enabledChannels.includes(channel)) state.enabledChannels.push(channel);
    this.save(state);
    return state;
  }
  setEnabledChannels(channels) {
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
  addExtension(extensionId) {
    const state = this.getState();
    if (!state.installedExtensions.includes(extensionId)) {
      state.installedExtensions.push(extensionId);
    }
    this.save(state);
    return state;
  }
  isFirstBoot() {
    return !existsSync(this.path);
  }
  withStackSpecState(state) {
    if (!this.stackSpecPath) return state;
    try {
      const spec = ensureStackSpec(this.stackSpecPath);
      state.accessScope = spec.accessScope;
      state.enabledChannels = Object.entries(spec.channels).filter(([, config]) => config.enabled).map(([name]) => name).sort();
    } catch {
    }
    return state;
  }
  withMutableStackSpec(mutator) {
    if (!this.stackSpecPath) return;
    try {
      const spec = ensureStackSpec(this.stackSpecPath);
      mutator(spec);
      writeFileSync(this.stackSpecPath, stringifyStackSpec(spec), "utf8");
    } catch {
    }
  }
}

export { DEFAULT_STATE, SetupManager };
//# sourceMappingURL=setup-manager-T6S6ERQC.js.map
