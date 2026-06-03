/**
 * Host ↔ Assistant AKM source wiring (control-plane logic — lives in lib).
 *
 * Implements the "symmetric writable secondary" design
 * (docs/technical/akm-host-assistant-integration-proposal.md §8).
 *
 * Each akm instance keeps its OWN primary stash, data dir, and cache. Sharing
 * is done purely by adding the other instance's stash as a *secondary* source
 * in `config.sources[]`:
 *   - The OpenPalm/container config gains a `host-akm` source → /host-stash
 *     (the user's personal ~/akm, bind-mounted by the host-akm.compose.yml overlay).
 *   - The personal config gains an `openpalm` source → OP_HOME/knowledge.
 *
 * VERIFIED against akm 0.8.0-rc.13:
 *  - `SourceConfigEntrySchema` (config-schema.ts:259) accepts
 *    { type, path?, url?, name?, enabled?, writable?, primary?, options?, wikiName? }.
 *  - The indexer's `resolveSourceEntries` (search-source.ts:56) ALWAYS injects the
 *    env-resolved primary stash (AKM_STASH_DIR) as sources[0], then appends
 *    config.sources[] deduped by path. So a secondary entry can never strand or
 *    displace the primary — provided we NEVER set `primary:true` and NEVER set
 *    `config.stashDir`.
 *  - Writes resolve to the primary unless an explicit `--target` is given
 *    (write-source.ts) and `defaultWriteTarget` is left unset, so a writable
 *    secondary is safe by construction.
 *
 * Invariants (enforced + unit-tested):
 *  - Only ever appends/updates a NAMED source (idempotent upsert by name).
 *  - NEVER sets `primary`, NEVER sets `defaultWriteTarget`, NEVER sets `stashDir`.
 *  - Atomic 0600 writes.
 *  - The OpenPalm config is parse-tolerant (we own it: corrupt → start from {}).
 *  - The PERSONAL config FAILS CLOSED (corrupt/unreadable → throw, never overwrite
 *    the user's file). This asymmetry is the host-data-loss guard.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import type { ControlPlaneState } from "./types.js";

/** Source entry name added to the OpenPalm/container config (points at /host-stash). */
export const HOST_SOURCE_NAME = "host-akm";

/** A filesystem source entry as akm persists it in config.sources[]. */
type FilesystemSourceEntry = {
  type: "filesystem";
  path: string;
  name: string;
  writable: boolean;
  enabled: boolean;
};

type AkmConfigObject = Record<string, unknown>;

function readConfigTolerant(configPath: string): AkmConfigObject {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as AkmConfigObject) : {};
  } catch {
    // We own the OpenPalm config — a corrupt file is recoverable by rewriting.
    return {};
  }
}

function readConfigFailClosed(configPath: string): AkmConfigObject {
  // The PERSONAL config belongs to the user. If it doesn't exist there is
  // nothing to share into and creating one silently would be surprising;
  // if it's corrupt we must NOT overwrite it. Both cases throw.
  if (!existsSync(configPath)) {
    throw new Error(
      `Personal akm config not found at ${configPath}; refusing to create it. ` +
        `Run \`akm init\`/\`akm setup\` first, then enable host AKM sharing.`,
    );
  }
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(`Unable to read personal akm config at ${configPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Personal akm config at ${configPath} is not valid JSON; refusing to overwrite it. ` +
        `Fix the file by hand, then retry.`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Personal akm config at ${configPath} is not a JSON object; refusing to overwrite it.`);
  }
  return parsed as AkmConfigObject;
}

/**
 * Upsert a named filesystem source into `config.sources[]` by name. Idempotent.
 * NEVER touches `primary`, `defaultWriteTarget`, or `stashDir`.
 */
function upsertSource(config: AkmConfigObject, entry: FilesystemSourceEntry): AkmConfigObject {
  const sources = Array.isArray(config.sources) ? [...(config.sources as unknown[])] : [];
  const idx = sources.findIndex(
    (s) => s && typeof s === "object" && (s as Record<string, unknown>).name === entry.name,
  );
  if (idx >= 0) {
    // Preserve any unrelated fields the user set (e.g. options), override ours.
    sources[idx] = { ...(sources[idx] as Record<string, unknown>), ...entry };
  } else {
    sources.push(entry);
  }
  return { ...config, sources };
}

function removeSource(config: AkmConfigObject, name: string): AkmConfigObject {
  if (!Array.isArray(config.sources)) return config;
  const sources = (config.sources as unknown[]).filter(
    (s) => !(s && typeof s === "object" && (s as Record<string, unknown>).name === name),
  );
  return { ...config, sources };
}

function assertNoPrimaryEscalation(entry: FilesystemSourceEntry): void {
  // Defense in depth: the type forbids `primary`, but assert at runtime too —
  // a secondary that became primary would change the write target.
  if ((entry as Record<string, unknown>).primary !== undefined) {
    throw new Error("akm-sources: refusing to write a source entry carrying `primary`.");
  }
}

function openpalmConfigPath(state: ControlPlaneState): string {
  return join(state.configDir, "akm", "config.json");
}

/**
 * Container/OpenPalm side: add the personal stash (mounted at /host-stash) as a
 * secondary source. Parse-tolerant (we own this config). Writable by default so
 * the assistant can contribute back via an explicit `--target host-akm`.
 */
export function addHostStashToOpenpalmConfig(state: ControlPlaneState, writable = true): void {
  const configPath = openpalmConfigPath(state);
  const entry: FilesystemSourceEntry = {
    type: "filesystem",
    path: "/host-stash",
    name: HOST_SOURCE_NAME,
    writable,
    enabled: true,
  };
  assertNoPrimaryEscalation(entry);
  const config = readConfigTolerant(configPath);
  const updated = upsertSource(config, entry);
  writeFileAtomic(configPath, JSON.stringify(updated, null, 2), 0o600);
}

/**
 * Remove the `host-akm` secondary source from the assistant config (disable
 * sharing). Parse-tolerant; never touches the user's personal config (D1 —
 * host sharing is assistant-reads-host only). Idempotent.
 */
export function removeHostAkmSource(state: ControlPlaneState): void {
  const opPath = openpalmConfigPath(state);
  const opConfig = readConfigTolerant(opPath);
  writeFileAtomic(opPath, JSON.stringify(removeSource(opConfig, HOST_SOURCE_NAME), null, 2), 0o600);
}

/**
 * Read-only snapshot import of the host's reusable akm config into the OpenPalm
 * config. Reads the personal config READ-ONLY; never writes back to the host.
 * Copies the LLM/agent/improve PROFILES (+ their `defaults.*`) and the top-level
 * `embedding` connection. Returns which sections were imported.
 *
 * Writes the canonical akm 0.8.0 shape (profiles.* + defaults.* + embedding) —
 * never the legacy top-level `llm` (see I-3). NEVER touches `sources`, `stashDir`,
 * `registries`, or `installed`.
 */
export function importHostProfiles(
  state: ControlPlaneState,
  hostConfigPath: string,
): { imported: string[] } {
  const host = readConfigFailClosed(hostConfigPath);
  const hostProfiles = (host.profiles as Record<string, unknown> | undefined) ?? {};
  const hostDefaults = (host.defaults as Record<string, unknown> | undefined) ?? {};

  const opPath = openpalmConfigPath(state);
  const op = readConfigTolerant(opPath);
  const opProfiles = (op.profiles as Record<string, unknown> | undefined) ?? {};
  const opDefaults = (op.defaults as Record<string, unknown> | undefined) ?? {};

  const imported: string[] = [];
  // All three profile namespaces akm supports (config-schema.ts ProfilesSchema).
  for (const ns of ["llm", "agent", "improve"] as const) {
    if (hostProfiles[ns] && typeof hostProfiles[ns] === "object") {
      opProfiles[ns] = { ...(opProfiles[ns] as object | undefined), ...(hostProfiles[ns] as object) };
      imported.push(`profiles.${ns}`);
    }
    if (typeof hostDefaults[ns] === "string") {
      opDefaults[ns] = hostDefaults[ns];
      imported.push(`defaults.${ns}`);
    }
  }

  // Top-level embedding connection (valid 0.8.0 key — EmbeddingConnectionConfigSchema).
  let embedding: unknown;
  if (host.embedding && typeof host.embedding === "object") {
    embedding = { ...(op.embedding as object | undefined), ...(host.embedding as object) };
    imported.push("embedding");
  }

  if (imported.length === 0) return { imported };

  const updated: AkmConfigObject = { ...op, profiles: opProfiles, defaults: opDefaults };
  if (embedding !== undefined) updated.embedding = embedding;
  delete (updated as Record<string, unknown>).llm; // never persist the legacy key
  writeFileAtomic(opPath, JSON.stringify(updated, null, 2), 0o600);
  return { imported };
}
