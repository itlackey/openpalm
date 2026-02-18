import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SetupState = {
  completed: boolean;
  completedAt?: string;
  accessScope: "host" | "lan";
  steps: {
    welcome: boolean;
    accessScope: boolean;
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
  steps: {
    welcome: false,
    accessScope: false,
    healthCheck: false,
    security: false,
    channels: false,
    extensions: false
  },
  enabledChannels: [],
  installedExtensions: []
};

export class SetupManager {
  private path: string;

  constructor(dataDir: string) {
    this.path = `${dataDir}/setup-state.json`;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  getState(): SetupState {
    if (!existsSync(this.path)) return { ...DEFAULT_STATE, steps: { ...DEFAULT_STATE.steps } };
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SetupState>;
    return {
      ...DEFAULT_STATE,
      ...parsed,
      accessScope: parsed.accessScope ?? DEFAULT_STATE.accessScope,
      steps: {
        ...DEFAULT_STATE.steps,
        ...(parsed.steps ?? {}),
      },
      enabledChannels: parsed.enabledChannels ?? [],
      installedExtensions: parsed.installedExtensions ?? [],
    };
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

  setAccessScope(scope: "host" | "lan") {
    const state = this.getState();
    state.accessScope = scope;
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
    if (!state.enabledChannels.includes(channel)) {
      state.enabledChannels.push(channel);
    }
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
