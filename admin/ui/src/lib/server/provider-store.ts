import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderConnection, ModelAssignment } from "@openpalm/lib";

export type ProviderState = {
  providers: ProviderConnection[];
  assignments: Record<string, { providerId: string; modelId: string }>;
};

const DEFAULT_STATE: ProviderState = {
  providers: [],
  assignments: {},
};

function sanitizeString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, "").trim();
}

function sanitizeProvider(value: unknown): ProviderConnection | null {
  if (!value || typeof value !== "object") return null;
  const src = value as Partial<ProviderConnection>;
  const id = sanitizeString(src.id);
  const name = sanitizeString(src.name);
  const url = sanitizeString(src.url);
  const apiKey = sanitizeString(src.apiKey);
  const createdAt = typeof src.createdAt === "string" ? src.createdAt : new Date().toISOString();
  if (!id || !name) return null;
  return { id, name, url, apiKey, createdAt };
}

function normalizeState(parsed: Partial<ProviderState>): ProviderState {
  const rawProviders = Array.isArray(parsed.providers) ? parsed.providers : [];
  const providers = rawProviders
    .map((p) => sanitizeProvider(p))
    .filter((p): p is ProviderConnection => p !== null);

  const assignments: Record<string, { providerId: string; modelId: string }> = {};
  if (parsed.assignments && typeof parsed.assignments === "object") {
    for (const [role, val] of Object.entries(parsed.assignments)) {
      if (val && typeof val === "object" && "providerId" in val && "modelId" in val) {
        const providerId = sanitizeString((val as Record<string, unknown>).providerId);
        const modelId = sanitizeString((val as Record<string, unknown>).modelId);
        if (providerId && modelId) assignments[role] = { providerId, modelId };
      }
    }
  }

  return { providers, assignments };
}

export class ProviderStore {
  private path: string;

  constructor(dataDir: string) {
    this.path = `${dataDir}/providers.json`;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  getState(): ProviderState {
    if (!existsSync(this.path)) return { ...DEFAULT_STATE, providers: [], assignments: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ProviderState>;
      return normalizeState(parsed);
    } catch {
      return { ...DEFAULT_STATE, providers: [], assignments: {} };
    }
  }

  save(state: ProviderState) {
    writeFileSync(this.path, JSON.stringify(state, null, 2), "utf8");
  }

  addProvider(provider: Omit<ProviderConnection, "id" | "createdAt">): ProviderConnection {
    const state = this.getState();
    const entry: ProviderConnection = {
      id: crypto.randomUUID(),
      name: sanitizeString(provider.name),
      url: sanitizeString(provider.url),
      apiKey: sanitizeString(provider.apiKey),
      createdAt: new Date().toISOString(),
    };
    state.providers.push(entry);
    this.save(state);
    return entry;
  }

  updateProvider(id: string, fields: Partial<Omit<ProviderConnection, "id" | "createdAt">>): ProviderConnection | null {
    const state = this.getState();
    const idx = state.providers.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    if (fields.name !== undefined) state.providers[idx].name = sanitizeString(fields.name);
    if (fields.url !== undefined) state.providers[idx].url = sanitizeString(fields.url);
    if (fields.apiKey !== undefined) state.providers[idx].apiKey = sanitizeString(fields.apiKey);
    this.save(state);
    return state.providers[idx];
  }

  removeProvider(id: string): boolean {
    const state = this.getState();
    const before = state.providers.length;
    state.providers = state.providers.filter((p) => p.id !== id);
    if (state.providers.length === before) return false;
    // Remove any assignments referencing this provider
    for (const [role, assignment] of Object.entries(state.assignments)) {
      if (assignment.providerId === id) delete state.assignments[role];
    }
    this.save(state);
    return true;
  }

  getProvider(id: string): ProviderConnection | undefined {
    return this.getState().providers.find((p) => p.id === id);
  }

  listProviders(): ProviderConnection[] {
    return this.getState().providers;
  }

  assignModel(role: ModelAssignment, providerId: string, modelId: string): ProviderState {
    const state = this.getState();
    if (!state.providers.some((p) => p.id === providerId)) {
      throw new Error("provider_not_found");
    }
    state.assignments[role] = { providerId, modelId: sanitizeString(modelId) };
    this.save(state);
    return state;
  }

  getAssignment(role: ModelAssignment): { providerId: string; modelId: string } | undefined {
    return this.getState().assignments[role];
  }
}
