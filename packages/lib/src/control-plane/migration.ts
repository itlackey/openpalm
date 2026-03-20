/**
 * v3 → v4 migration for the unified configuration layer.
 *
 * Reads all v3 sources (openpalm.yaml, openpalm.yml, profiles.json,
 * system.env, user.env) and produces a v4 StackSpec. Idempotent.
 */
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import type { StackSpec, StackSpecV3, StackSpecConnection, StackSpecConnectionAuth, StackSpecAssignments } from "./stack-spec.js";
import { readRawStackSpec, writeStackSpec, upgradeV3ToV4InMemory } from "./stack-spec.js";
import { parseEnvFile } from "./env.js";
import type { ControlPlaneState } from "./types.js";
import type { CanonicalConnectionsDocument } from "./types.js";

export type MigrationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  actions: string[];
};

/**
 * Migrate a v3 installation to v4 in one idempotent pass.
 *
 * Reads existing v3 sources and merges into a v4 StackSpec.
 * Archives consumed files as .v3.bak. Does NOT delete anything.
 * Does NOT modify vault/user.env secrets (API keys stay untouched).
 */
export function migrateV3ToV4(state: ControlPlaneState): MigrationResult {
  const result: MigrationResult = { ok: true, errors: [], warnings: [], actions: [] };

  // ── 1. Read current state ─────────────────────────────────────────

  const rawSpec = readRawStackSpec(state.configDir);

  // Already v4? Nothing to do.
  if (rawSpec && rawSpec.version === 4) {
    result.actions.push("Already at v4; no migration needed");
    return result;
  }

  // Read the legacy .yml flags file (separate from .yaml StackSpec)
  const ymlFlags = readYmlFlags(state.configDir);

  // Read system.env for non-secret values
  const systemEnvPath = join(state.vaultDir, "system.env");
  const systemEnv = existsSync(systemEnvPath) ? parseEnvFile(systemEnvPath) : {};

  // Read user.env for config values that need to move
  const userEnvPath = join(state.vaultDir, "user.env");
  const userEnv = existsSync(userEnvPath) ? parseEnvFile(userEnvPath) : {};

  // Read profiles.json for richer connection data
  const profiles = readProfilesJson(state.configDir);

  // ── 2. Build v4 spec ──────────────────────────────────────────────

  let v4: StackSpec;

  if (rawSpec && rawSpec.version === 3) {
    // Start from the v3 auto-upgrade
    v4 = upgradeV3ToV4InMemory(rawSpec as StackSpecV3);
    result.actions.push("Upgraded v3 StackSpec to v4 in memory");

    // Enrich connections from profiles.json if available
    if (profiles && profiles.profiles?.length > 0) {
      v4.connections = mergeConnectionsFromProfiles(v4.connections, profiles);
      result.actions.push(`Enriched ${v4.connections.length} connections from profiles.json`);
    }

    // Enrich assignments from profiles.json
    if (profiles?.assignments) {
      v4.assignments = mergeAssignmentsFromProfiles(v4.assignments, profiles.assignments);
      result.actions.push("Enriched assignments from profiles.json");
    }
  } else if (profiles && profiles.profiles?.length > 0) {
    // No StackSpec at all, but profiles exist
    v4 = buildFromProfilesOnly(profiles);
    result.actions.push("Built v4 spec from profiles.json (no StackSpec found)");
  } else {
    // Fresh install or no config — create minimal v4
    v4 = {
      version: 4,
      connections: [],
      assignments: {
        llm: { connectionId: "", model: "" },
        embeddings: { connectionId: "", model: "" },
      },
    };
    result.warnings.push("No v3 config found; created minimal v4 spec");
  }

  // ── 3. Merge feature flags from all sources ───────────────────────

  const ollamaEnabled =
    ymlFlags?.ollama === true ||
    v4.features?.ollama === true ||
    systemEnv.OPENPALM_OLLAMA_ENABLED?.toLowerCase() === "true";

  const adminEnabled =
    ymlFlags?.admin === true ||
    v4.features?.admin === true ||
    systemEnv.OPENPALM_ADMIN_ENABLED?.toLowerCase() === "true";

  v4.features = { ollama: ollamaEnabled, admin: adminEnabled };
  result.actions.push("Merged feature flags from openpalm.yml + system.env");

  // ── 4. Extract infrastructure config from system.env ──────────────

  const parsePort = (v: string | undefined, def: number): number =>
    v ? (Number.parseInt(v, 10) || def) : def;

  const hasPorts =
    systemEnv.OPENPALM_INGRESS_PORT || systemEnv.OPENPALM_ASSISTANT_PORT ||
    systemEnv.OPENPALM_ADMIN_PORT || systemEnv.OPENPALM_MEMORY_PORT;

  if (hasPorts) {
    v4.ports = {
      ingress: parsePort(systemEnv.OPENPALM_INGRESS_PORT, 3080),
      assistant: parsePort(systemEnv.OPENPALM_ASSISTANT_PORT, 3800),
      admin: parsePort(systemEnv.OPENPALM_ADMIN_PORT, 3880),
      adminOpencode: parsePort(systemEnv.OPENPALM_ADMIN_OPENCODE_PORT, 3881),
      scheduler: parsePort(systemEnv.OPENPALM_SCHEDULER_PORT, 3897),
      memory: parsePort(systemEnv.OPENPALM_MEMORY_PORT, 3898),
      guardian: parsePort(systemEnv.OPENPALM_GUARDIAN_PORT, 3899),
      assistantSsh: parsePort(systemEnv.OPENPALM_ASSISTANT_SSH_PORT, 2222),
    };
    result.actions.push("Extracted port configuration from system.env");
  }

  if (systemEnv.OPENPALM_INGRESS_BIND_ADDRESS && systemEnv.OPENPALM_INGRESS_BIND_ADDRESS !== "127.0.0.1") {
    v4.network = { bindAddress: systemEnv.OPENPALM_INGRESS_BIND_ADDRESS };
    result.actions.push("Extracted bind address from system.env");
  }

  if (systemEnv.OPENPALM_IMAGE_NAMESPACE || systemEnv.OPENPALM_IMAGE_TAG) {
    v4.image = {};
    if (systemEnv.OPENPALM_IMAGE_NAMESPACE && systemEnv.OPENPALM_IMAGE_NAMESPACE !== "openpalm") {
      v4.image.namespace = systemEnv.OPENPALM_IMAGE_NAMESPACE;
    }
    if (systemEnv.OPENPALM_IMAGE_TAG && systemEnv.OPENPALM_IMAGE_TAG !== "latest") {
      v4.image.tag = systemEnv.OPENPALM_IMAGE_TAG;
    }
    if (!v4.image.namespace && !v4.image.tag) delete v4.image;
    else result.actions.push("Extracted image config from system.env");
  }

  if (systemEnv.OPENPALM_UID || systemEnv.OPENPALM_GID || systemEnv.OPENPALM_DOCKER_SOCK) {
    v4.runtime = {};
    if (systemEnv.OPENPALM_UID) {
      const uid = Number.parseInt(systemEnv.OPENPALM_UID, 10);
      if (!Number.isNaN(uid)) v4.runtime.uid = uid;
    }
    if (systemEnv.OPENPALM_GID) {
      const gid = Number.parseInt(systemEnv.OPENPALM_GID, 10);
      if (!Number.isNaN(gid)) v4.runtime.gid = gid;
    }
    if (systemEnv.OPENPALM_DOCKER_SOCK && systemEnv.OPENPALM_DOCKER_SOCK !== "/var/run/docker.sock") {
      v4.runtime.dockerSock = systemEnv.OPENPALM_DOCKER_SOCK;
    }
    result.actions.push("Extracted runtime config from system.env");
  }

  // ── 5. Extract memory userId from user.env ────────────────────────

  const memoryUserId = userEnv.MEMORY_USER_ID || userEnv.OPENMEMORY_USER_ID;
  if (memoryUserId && memoryUserId !== "default_user") {
    v4.memory = { userId: memoryUserId };
    result.actions.push("Extracted memory userId from user.env");
  }

  // ── 6. Write v4 spec ──────────────────────────────────────────────

  // Back up existing files
  backupFile(join(state.configDir, "openpalm.yaml"), result);
  backupFile(join(state.configDir, "openpalm.yml"), result);
  backupFile(join(state.configDir, "connections", "profiles.json"), result);

  writeStackSpec(state.configDir, v4);
  result.actions.push("Wrote v4 StackSpec to config/openpalm.yaml");

  // ── 7. Leave legacy .yml in place (non-destructive per core principles) ──
  // readStackSpec() checks openpalm.yaml first, so .yaml takes precedence.
  // The .yml file is already backed up above if it exists.
  const ymlPath = join(state.configDir, "openpalm.yml");
  if (existsSync(ymlPath)) {
    result.warnings.push(
      "config/openpalm.yml still exists. It is superseded by config/openpalm.yaml (v4). " +
      "You may safely delete it after verifying the migration.",
    );
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────

function readYmlFlags(configDir: string): Record<string, unknown> | null {
  const path = join(configDir, "openpalm.yml");
  if (!existsSync(path)) return null;
  try {
    const raw = yamlParse(readFileSync(path, "utf-8"), { maxAliasCount: 100 });
    if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  } catch { /* ignore corrupt */ }
  return null;
}

function readProfilesJson(configDir: string): CanonicalConnectionsDocument | null {
  const path = join(configDir, "connections", "profiles.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw?.version === 1 && Array.isArray(raw?.profiles)) {
      return raw as CanonicalConnectionsDocument;
    }
  } catch { /* ignore corrupt */ }
  return null;
}

function mergeConnectionsFromProfiles(
  v4Connections: StackSpecConnection[],
  profiles: CanonicalConnectionsDocument,
): StackSpecConnection[] {
  const byId = new Map(v4Connections.map((c) => [c.id, c]));

  for (const p of profiles.profiles) {
    const existing = byId.get(p.id);
    const auth = p.auth
      ? convertProfileAuth(p as { auth?: { mode: string; apiKeySecretRef?: string } })
      : existing?.auth;
    byId.set(p.id, {
      id: p.id,
      name: p.name,
      provider: p.provider,
      baseUrl: p.baseUrl,
      kind: (p.kind as StackSpecConnection["kind"]) ?? existing?.kind,
      auth,
    });
  }

  return [...byId.values()];
}

function mergeAssignmentsFromProfiles(
  v4Assignments: StackSpecAssignments,
  profileAssignments: Record<string, unknown>,
): StackSpecAssignments {
  const merged = { ...v4Assignments };

  // Merge optional capabilities from profiles.json with explicit field mapping
  const reranking = profileAssignments.reranking;
  if (reranking && typeof reranking === "object") {
    merged.reranking = reranking as StackSpecAssignments["reranking"];
  }
  const tts = profileAssignments.tts;
  if (tts && typeof tts === "object") {
    merged.tts = tts as StackSpecAssignments["tts"];
  }
  const stt = profileAssignments.stt;
  if (stt && typeof stt === "object") {
    merged.stt = stt as StackSpecAssignments["stt"];
  }

  return merged;
}

function convertProfileAuth(p: { auth?: { mode: string; apiKeySecretRef?: string } }): StackSpecConnectionAuth | undefined {
  if (!p.auth) return undefined;
  if (p.auth.mode === "api_key" && p.auth.apiKeySecretRef) {
    return { mode: "api_key", secretRef: p.auth.apiKeySecretRef };
  }
  return { mode: "none" };
}

function buildFromProfilesOnly(profiles: CanonicalConnectionsDocument): StackSpec {
  return {
    version: 4,
    connections: profiles.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      baseUrl: p.baseUrl,
      kind: p.kind as StackSpecConnection["kind"],
      auth: convertProfileAuth(p as { auth?: { mode: string; apiKeySecretRef?: string } }),
    })),
    assignments: {
      llm: profiles.assignments?.llm ?? { connectionId: "", model: "" },
      embeddings: {
        connectionId: profiles.assignments?.embeddings?.connectionId ?? "",
        model: profiles.assignments?.embeddings?.model ?? "",
        dims: profiles.assignments?.embeddings?.embeddingDims,
      },
      ...(profiles.assignments?.reranking && typeof profiles.assignments.reranking === "object"
        ? { reranking: profiles.assignments.reranking as StackSpecAssignments["reranking"] } : {}),
      ...(profiles.assignments?.tts && typeof profiles.assignments.tts === "object"
        ? { tts: profiles.assignments.tts as StackSpecAssignments["tts"] } : {}),
      ...(profiles.assignments?.stt && typeof profiles.assignments.stt === "object"
        ? { stt: profiles.assignments.stt as StackSpecAssignments["stt"] } : {}),
    },
  };
}

function backupFile(path: string, result: MigrationResult): void {
  if (!existsSync(path)) return;
  const backup = `${path}.v3.bak`;
  try {
    copyFileSync(path, backup);
    result.actions.push(`Backed up ${path} -> ${backup}`);
  } catch (err) {
    result.warnings.push(`Could not back up ${path}: ${err}`);
  }
}
