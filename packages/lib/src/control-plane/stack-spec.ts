/**
 * Stack specification file (stack.yml) management.
 *
 * The stack spec is a YAML document that captures the high-level
 * configuration of an OpenPalm installation: capabilities
 * and optional services. It lives in CONFIG_HOME.
 *
 * v2: Capabilities-based schema. No connections array — capabilities
 *     carry their own provider info.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

// ── Capability Types ────────────────────────────────────────────────────

export type StackSpecEmbeddings = {
  provider: string;
  model: string;
  dims: number;
};

export type StackSpecMemory = {
  userId: string;
  customInstructions?: string;
};

export type StackSpecTts = {
  enabled: boolean;
  provider?: string;
  model?: string;
  voice?: string;
  format?: string;
};

export type StackSpecStt = {
  enabled: boolean;
  provider?: string;
  model?: string;
  language?: string;
};

export type StackSpecReranker = {
  enabled: boolean;
  provider?: string;
  mode?: "llm" | "dedicated";
  model?: string;
  topK?: number;
  topN?: number;
};

export type StackSpecCapabilities = {
  /** Primary LLM: "provider/model" */
  llm: string;
  /** Small/fast model: "provider/model" */
  slm?: string;
  embeddings: StackSpecEmbeddings;
  memory: StackSpecMemory;
  tts?: StackSpecTts;
  stt?: StackSpecStt;
  reranking?: StackSpecReranker;
};

// ── Service Types ───────────────────────────────────────────────────────

export type StackSpecServiceValue = { env?: Record<string, string> };

// ── StackSpec v2 ────────────────────────────────────────────────────────

export type StackSpec = {
  version: 2;
  capabilities: StackSpecCapabilities;
  services?: Record<string, StackSpecServiceValue>;
};

// ── Constants ───────────────────────────────────────────────────────────

export const STACK_SPEC_FILENAME = "stack.yml";

export const SPEC_DEFAULTS = {
  ports: {
    assistant: 3800,
    admin: 3880,
    adminOpencode: 3881,
    memory: 3898,
    guardian: 3899,
    assistantSsh: 2222,
  },
  image: {
    namespace: "openpalm",
    tag: "latest",
  },
} as const;

// ── Capability Helpers ──────────────────────────────────────────────────

/** Parse a "provider/model" capability string into parts */
export function parseCapabilityString(cap: string): { provider: string; model: string } {
  const idx = cap.indexOf("/");
  if (idx < 0) return { provider: cap, model: "" };
  return { provider: cap.slice(0, idx), model: cap.slice(idx + 1) };
}

/** Format provider + model into a capability string */
export function formatCapabilityString(provider: string, model: string): string {
  return `${provider}/${model}`;
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
  if (obj.version !== 2) return null;
  if (typeof obj.capabilities !== "object" || obj.capabilities === null) return null;
  return obj as unknown as StackSpec;
}

/**
 * Update a single capability key in the stack spec.
 */
export function updateCapability(configDir: string, key: string, value: unknown): void {
  const spec = readStackSpec(configDir);
  if (!spec) throw new Error("stack.yml not found or invalid");
  (spec.capabilities as Record<string, unknown>)[key] = value;
  writeStackSpec(configDir, spec);
}
