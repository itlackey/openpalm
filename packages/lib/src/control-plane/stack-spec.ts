/**
 * Stack specification file (openpalm.yaml) management.
 *
 * The stack spec is a YAML document that captures the high-level
 * configuration of an OpenPalm installation: connections, capability
 * assignments, and feature flags. It lives in CONFIG_HOME.
 *
 * v3: Original format (connections, assignments, ollamaEnabled)
 * v4: Unified config layer — absorbs profiles.json, adds ports/network/image/runtime
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

// ── v3 Types (legacy, kept for migration) ────────────────────────────────

export type StackSpecConnectionV3 = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
};

export type StackSpecAssignmentsV3 = {
  llm: { connectionId: string; model: string; smallModel?: string };
  embeddings: { connectionId: string; model: string; embeddingDims?: number };
};

export type StackSpecV3 = {
  version: 3;
  connections: StackSpecConnectionV3[];
  assignments: StackSpecAssignmentsV3;
  ollamaEnabled: boolean;
  voice?: { tts?: string; stt?: string };
  channels?: string[];
  services?: Record<string, boolean>;
};

// ── v4 Types (unified config layer) ──────────────────────────────────────

export type StackSpecConnectionAuth =
  | { mode: "none" }
  | { mode: "api_key"; secretRef: string };

export type StackSpecConnection = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  kind?: "openai_compatible_remote" | "openai_compatible_local" | "ollama_local";
  auth?: StackSpecConnectionAuth;
};

export type StackSpecAssignments = {
  llm: { connectionId: string; model: string; smallModel?: string };
  embeddings: { connectionId: string; model: string; dims?: number };
  reranking?: {
    enabled: boolean;
    connectionId?: string;
    mode?: string;
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

export type StackSpecPorts = {
  ingress?: number;
  assistant?: number;
  admin?: number;
  adminOpencode?: number;
  scheduler?: number;
  memory?: number;
  guardian?: number;
  assistantSsh?: number;
};

export type StackSpecNetwork = {
  bindAddress?: string;
};

export type StackSpecImage = {
  namespace?: string;
  tag?: string;
};

export type StackSpecRuntime = {
  uid?: number;
  gid?: number;
  dockerSock?: string;
};

export type StackSpecChannelConfig = {
  name?: string;
  description?: string;
  enabled?: boolean;
  volumes?: string[];
};

export type StackSpecServiceConfig = {
  name?: string;
  description?: string;
  enabled?: boolean;
};

export type StackSpec = {
  version: 4;
  connections: StackSpecConnection[];
  assignments: StackSpecAssignments;
  features?: {
    ollama?: boolean;
    admin?: boolean;
  };
  ports?: StackSpecPorts;
  network?: StackSpecNetwork;
  image?: StackSpecImage;
  runtime?: StackSpecRuntime;
  memory?: {
    userId?: string;
  };
  channels?: Record<string, StackSpecChannelConfig | boolean>;
  services?: Record<string, StackSpecServiceConfig | boolean>;
  voice?: { tts?: string; stt?: string };
};

/** Alias: StackSpec is always v4 in the current codebase. */
export type StackSpecV4 = StackSpec;

// ── Constants ──────────────────────────────────────────────────────────

export const STACK_SPEC_FILENAME = "openpalm.yaml";

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

// ── v3 → v4 In-Memory Upgrade ──────────────────────────────────────────

export function upgradeV3ToV4InMemory(v3: StackSpecV3): StackSpec {
  return {
    version: 4,
    connections: (v3.connections ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      baseUrl: c.baseUrl ?? "",
    })),
    assignments: {
      llm: v3.assignments?.llm ?? { connectionId: "", model: "" },
      embeddings: {
        connectionId: v3.assignments?.embeddings?.connectionId ?? "",
        model: v3.assignments?.embeddings?.model ?? "",
        dims: v3.assignments?.embeddings?.embeddingDims,
      },
    },
    features: {
      ollama: v3.ollamaEnabled ?? false,
      admin: v3.services?.admin ?? false,
    },
    voice: v3.voice,
    channels: v3.channels
      ? Object.fromEntries(v3.channels.map((c) => [c, true]))
      : undefined,
    services: v3.services
      ? Object.fromEntries(
          Object.entries(v3.services)
            .filter(([k]) => k !== "admin")
            .map(([k, v]) => [k, v]),
        )
      : undefined,
  };
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
 * Write a v3 spec for backward compatibility during migration.
 * @deprecated Use writeStackSpec (v4) instead.
 */
export function writeStackSpecV3(configDir: string, spec: StackSpecV3): void {
  mkdirSync(configDir, { recursive: true });
  const content = yamlStringify(spec, { indent: 2 });
  writeFileSync(stackSpecPath(configDir), content);
}

/**
 * Read the stack spec, auto-upgrading v3 to v4 in memory.
 * Returns null for missing, corrupt, or unrecognized version files.
 * Also checks openpalm.yml as fallback for the .yaml/.yml inconsistency.
 */
export function readStackSpec(configDir: string): StackSpec | null {
  for (const filename of [STACK_SPEC_FILENAME, "openpalm.yml"]) {
    const path = `${configDir}/${filename}`;
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = yamlParse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (obj.version === 3) return upgradeV3ToV4InMemory(obj as unknown as StackSpecV3);
    if (obj.version === 4) return obj as unknown as StackSpec;
  }
  return null;
}

/**
 * Read the raw stack spec without auto-upgrade. Returns the version as-is.
 * Useful for migration code that needs to know the original version.
 */
export function readRawStackSpec(configDir: string): (StackSpecV3 | StackSpec) | null {
  for (const filename of [STACK_SPEC_FILENAME, "openpalm.yml"]) {
    const path = `${configDir}/${filename}`;
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = yamlParse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (obj.version === 3) return obj as unknown as StackSpecV3;
    if (obj.version === 4) return obj as unknown as StackSpec;
  }
  return null;
}
