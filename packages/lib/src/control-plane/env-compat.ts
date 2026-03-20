/**
 * Environment variable compatibility layer for OP_ prefix migration.
 *
 * During the deprecation period, both OP_* (new) and OPENPALM_* (old)
 * names are accepted. New name takes precedence.
 *
 * This module is the SINGLE place where aliasing lives. All other code
 * should use resolveEnv() instead of reading process.env directly for
 * aliased variables.
 */

// ── Alias Table ──────────────────────────────────────────────────────────
// [newName, oldName]

export const ENV_ALIASES: ReadonlyArray<readonly [string, string]> = [
  // Paths
  ["OP_HOME", "OPENPALM_HOME"],
  ["OP_WORK_DIR", "OPENPALM_WORK_DIR"],

  // Auth tokens (secrets)
  ["OP_ADMIN_TOKEN", "OPENPALM_ADMIN_TOKEN"],
  ["OP_ASSISTANT_TOKEN", "ASSISTANT_TOKEN"],
  ["OP_MEMORY_TOKEN", "MEMORY_AUTH_TOKEN"],
  ["OP_OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"],

  // Runtime
  ["OP_UID", "OPENPALM_UID"],
  ["OP_GID", "OPENPALM_GID"],
  ["OP_DOCKER_SOCK", "OPENPALM_DOCKER_SOCK"],

  // Image
  ["OP_IMAGE_NAMESPACE", "OPENPALM_IMAGE_NAMESPACE"],
  ["OP_IMAGE_TAG", "OPENPALM_IMAGE_TAG"],

  // Network
  ["OP_INGRESS_PORT", "OPENPALM_INGRESS_PORT"],
  ["OP_INGRESS_BIND", "OPENPALM_INGRESS_BIND_ADDRESS"],
  ["OP_ASSISTANT_PORT", "OPENPALM_ASSISTANT_PORT"],
  ["OP_ASSISTANT_BIND", "OPENPALM_ASSISTANT_BIND_ADDRESS"],
  ["OP_ASSISTANT_SSH_PORT", "OPENPALM_ASSISTANT_SSH_PORT"],
  ["OP_ASSISTANT_SSH_BIND", "OPENPALM_ASSISTANT_SSH_BIND_ADDRESS"],
  ["OP_ADMIN_PORT", "OPENPALM_ADMIN_PORT"],
  ["OP_ADMIN_OPENCODE_PORT", "OPENPALM_ADMIN_OPENCODE_PORT"],
  ["OP_ADMIN_OPENCODE_BIND", "OPENPALM_ADMIN_OPENCODE_BIND_ADDRESS"],
  ["OP_SCHEDULER_PORT", "OPENPALM_SCHEDULER_PORT"],
  ["OP_MEMORY_PORT", "OPENPALM_MEMORY_PORT"],
  ["OP_MEMORY_BIND", "OPENPALM_MEMORY_BIND_ADDRESS"],
  ["OP_GUARDIAN_PORT", "OPENPALM_GUARDIAN_PORT"],
  ["OP_OLLAMA_BIND", "OPENPALM_OLLAMA_BIND_ADDRESS"],

  // Feature flags
  ["OP_SETUP_COMPLETE", "OPENPALM_SETUP_COMPLETE"],
  ["OP_OLLAMA_ENABLED", "OPENPALM_OLLAMA_ENABLED"],
  ["OP_ADMIN_ENABLED", "OPENPALM_ADMIN_ENABLED"],

  // Setup
  ["OP_SETUP_PORT", "OPENPALM_SETUP_PORT"],
] as const;

const NEW_TO_OLD = new Map(ENV_ALIASES.map(([n, o]) => [n, o]));
const OLD_TO_NEW = new Map(ENV_ALIASES.map(([n, o]) => [o, n]));

const _warned = new Set<string>();

/**
 * Resolve an env var by its NEW name, falling back to the old name.
 * Emits a deprecation warning (once per key) when the old name is used.
 *
 * @param newName The OP_* variable name
 * @param env Optional env source (defaults to process.env / Bun.env)
 */
export function resolveEnv(
  newName: string,
  env?: Record<string, string | undefined>,
): string | undefined {
  const source =
    env ??
    (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;

  const newVal = source[newName];
  if (newVal !== undefined && newVal !== "") return newVal;

  const oldName = NEW_TO_OLD.get(newName);
  if (!oldName) return undefined;

  const oldVal = source[oldName];
  if (oldVal !== undefined && oldVal !== "") {
    if (!_warned.has(oldName)) {
      _warned.add(oldName);
      if (!source.VITEST && !source.BUN_TEST) {
        console.warn(`[openpalm] ${oldName} is deprecated; use ${newName}`);
      }
    }
    return oldVal;
  }
  return undefined;
}

/**
 * Resolve from a parsed env file Record (not process.env).
 * New name takes precedence over old name.
 */
export function resolveEnvFromFile(
  parsed: Record<string, string>,
  newName: string,
): string | undefined {
  if (newName in parsed && parsed[newName] !== "") return parsed[newName];
  const oldName = NEW_TO_OLD.get(newName);
  if (oldName && oldName in parsed && parsed[oldName] !== "") return parsed[oldName];
  return undefined;
}

/**
 * When writing env files, produce BOTH old and new names during deprecation.
 * This ensures old compose templates that reference ${OPENPALM_*} still work.
 */
export function dualWriteEnvPair(
  newName: string,
  value: string,
): Record<string, string> {
  const result: Record<string, string> = { [newName]: value };
  const oldName = NEW_TO_OLD.get(newName);
  if (oldName) result[oldName] = value;
  return result;
}

/** Get the old name for a new name (for display/migration messages). */
export function getOldName(newName: string): string | undefined {
  return NEW_TO_OLD.get(newName);
}

/** Get the new name for an old name. */
export function getNewName(oldName: string): string | undefined {
  return OLD_TO_NEW.get(oldName);
}

/** Reset deprecation warnings (for testing). */
export function resetWarnings(): void {
  _warned.clear();
}
