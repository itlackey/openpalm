/**
 * Stack specification file (stack.yaml) management.
 *
 * The stack spec is a YAML document that captures the high-level
 * configuration of an OpenPalm installation: connections, capability
 * assignments, and addons. It lives in CONFIG_HOME.
 *
 * v1: Clean break — connections, assignments (llm, slm, embeddings, memory,
 *     tts, stt, reranking), and addons list. Replaces openpalm.yaml (v3/v4)
 *     and profiles.json.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

// ── Connection Types ────────────────────────────────────────────────────

export type StackSpecConnectionAuth =
  | { mode: "api_key"; apiKeySecretRef?: string }
  | { mode: "none" };

export type StackSpecConnectionKind =
  | "openai_compatible_remote"
  | "openai_compatible_local"
  | "ollama_local"
  | "ollama_stack";

export type StackSpecConnection = {
  id: string;
  name: string;
  kind: StackSpecConnectionKind;
  provider: string;
  baseUrl: string;
  auth: StackSpecConnectionAuth;
};

// ── Assignment Types ────────────────────────────────────────────────────

export type StackSpecModelAssignment = {
  connectionId: string;
  model: string;
};

export type StackSpecEmbeddingsAssignment = {
  connectionId: string;
  model: string;
  embeddingDims?: number;
};

export type StackSpecMemoryAssignment = {
  llm: { connectionId: string; model: string; temperature?: number; maxTokens?: number };
  embeddings: { connectionId: string; model: string };
  vectorStore: { provider: "sqlite-vec" | "qdrant"; collectionName: string; dbPath: string };
  customInstructions?: string;
};

export type StackSpecTtsAssignment = {
  enabled: boolean;
  connectionId?: string;
  model?: string;
  voice?: string;
  format?: string;
};

export type StackSpecSttAssignment = {
  enabled: boolean;
  connectionId?: string;
  model?: string;
  language?: string;
};

export type StackSpecRerankerAssignment = {
  enabled: boolean;
  connectionId?: string;
  mode?: "llm" | "dedicated";
  model?: string;
  topK?: number;
  topN?: number;
};

export type StackSpecAssignments = {
  llm: StackSpecModelAssignment;
  slm?: StackSpecModelAssignment;
  embeddings: StackSpecEmbeddingsAssignment;
  memory: StackSpecMemoryAssignment;
  tts?: StackSpecTtsAssignment;
  stt?: StackSpecSttAssignment;
  reranking?: StackSpecRerankerAssignment;
};

// ── Addon Types ─────────────────────────────────────────────────────────

/** Addon can be a simple string or an object with env config */
export type StackSpecAddon = string | Record<string, Record<string, string>>;

// ── StackSpec v1 ────────────────────────────────────────────────────────

export type StackSpec = {
  version: 1;
  connections: StackSpecConnection[];
  assignments: StackSpecAssignments;
  addons: StackSpecAddon[];
};

// ── Constants ───────────────────────────────────────────────────────────

export const STACK_SPEC_FILENAME = "stack.yaml";

export const SPEC_DEFAULTS = {
  ports: {
    ingress: 3080,
    assistant: 3800,
    admin: 3880,
    adminOpencode: 3881,
    scheduler: 3897,
    memory: 3898,
    guardian: 3899,
    assistantSsh: 2222,
  },
  network: {
    bindAddress: "127.0.0.1",
  },
  image: {
    namespace: "openpalm",
    tag: "latest",
  },
} as const;

// ── Addon Helpers ───────────────────────────────────────────────────────

/** Normalize a mixed addon entry into { name, env } */
export function normalizeAddon(entry: StackSpecAddon): { name: string; env: Record<string, string> } {
  if (typeof entry === "string") return { name: entry, env: {} };
  const keys = Object.keys(entry);
  if (keys.length === 0) return { name: "", env: {} };
  const name = keys[0];
  return { name, env: entry[name] ?? {} };
}

/** Check if an addon is enabled by name */
export function hasAddon(spec: StackSpec, name: string): boolean {
  return spec.addons.some((a) => normalizeAddon(a).name === name);
}

/** Get the list of addon names */
export function addonNames(spec: StackSpec): string[] {
  return spec.addons.map((a) => normalizeAddon(a).name);
}

// ── Read / Write ────────────────────────────────────────────────────────

export function stackSpecPath(configDir: string): string {
  return `${configDir}/${STACK_SPEC_FILENAME}`;
}

export function writeStackSpec(configDir: string, spec: StackSpec): void {
  mkdirSync(configDir, { recursive: true });
  const content = yamlStringify(spec, { indent: 2 });
  writeFileSync(stackSpecPath(configDir), content);
}

/**
 * Read the stack spec. Returns null for missing, corrupt, or unrecognized version files.
 */
export function readStackSpec(configDir: string): StackSpec | null {
  const path = stackSpecPath(configDir);
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = yamlParse(readFileSync(path, "utf-8"), { maxAliasCount: 100 });
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;
  if (!Array.isArray(obj.connections)) return null;
  if (typeof obj.assignments !== "object" || obj.assignments === null) return null;
  if (!Array.isArray(obj.addons)) obj.addons = [];
  return obj as unknown as StackSpec;
}
