/**
 * Unified component system for the OpenPalm control plane.
 *
 * A component is a directory containing compose.yml + .env.schema + optional .caddy.
 * Components are discovered from three catalog sources (built-in, registry, user-local)
 * and instantiated into data/components/ when enabled.
 *
 * This module provides:
 * - Component types and constants
 * - Discovery across catalog sources
 * - Compose label parsing
 * - Overlay safety validation
 * - Cross-component env injection collision detection
 * - Instance ID validation
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { CORE_SERVICES, OPTIONAL_SERVICES } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("components");

// ── Types ──────────────────────────────────────────────────────────────

/** A component definition from any catalog source */
export type ComponentDefinition = {
  id: string;                    // directory name (e.g., "discord", "caddy")
  source: ComponentSource;       // where it came from
  sourceDir: string;             // absolute path to source directory
  composePath: string;           // absolute path to compose.yml
  schemaPath: string;            // absolute path to .env.schema
  caddyPath: string | null;      // absolute path to .caddy (if present)
  labels: ComponentLabels;       // parsed from compose.yml
};

export type ComponentSource = "builtin" | "registry" | "user-local";

export type ComponentLabels = {
  name: string;                  // openpalm.name (required)
  description: string;           // openpalm.description (required)
  icon?: string;                 // openpalm.icon (Lucide icon name)
  category?: string;             // openpalm.category (messaging, networking, ai, etc.)
  docs?: string;                 // openpalm.docs (path or URL)
  healthcheck?: string;          // openpalm.healthcheck (URL on internal network)
};

/** An enabled component instance */
export type EnabledInstance = {
  id: string;                    // user-chosen instance name (e.g., "discord-main")
  component: string;             // source component id (e.g., "discord")
  enabled: boolean;              // whether included in compose overlay chain
};

/** Runtime status of an instance */
export type InstanceStatus = "running" | "stopped" | "error" | "unknown";

/** Full instance detail including runtime info */
export type InstanceDetail = EnabledInstance & {
  instanceDir: string;           // absolute path to data/components/{id}/
  composePath: string;           // absolute path to instance compose.yml
  envPath: string;               // absolute path to instance .env
  schemaPath: string;            // absolute path to instance .env.schema
  caddyPath: string | null;      // absolute path to instance .caddy
  dataDir: string;               // absolute path to instance data/ subdirectory
  status: InstanceStatus;
};

/** Validation result for overlay safety */
export type OverlayValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

/** Env injection collision */
export type EnvInjectionCollision = {
  variable: string;
  targetService: string;
  sources: string[];  // instance IDs that inject the same var
};

// ── Constants ──────────────────────────────────────────────────────────

/** Strict instance ID: lowercase alphanumeric + hyphens, 1-63 chars, starts with alnum */
const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Additional Compose service names used by the core stack (not in CORE_SERVICES/OPTIONAL_SERVICES) */
const COMPOSE_SERVICE_ALIASES = ["opencode-core", "gateway", "openmemory"] as const;

/**
 * All core/optional service names used for overlay validation.
 * Derived from the canonical CORE_SERVICES + OPTIONAL_SERVICES lists in types.ts,
 * plus the additional Compose service aliases.
 */
const CORE_SERVICE_NAMES = new Set<string>([
  ...CORE_SERVICES,
  ...OPTIONAL_SERVICES,
  ...COMPOSE_SERVICE_ALIASES,
]);

/**
 * Reserved names that cannot be used as instance IDs.
 * Derived from CORE_SERVICE_NAMES so the two never diverge.
 */
const RESERVED_NAMES = CORE_SERVICE_NAMES;

// ── Instance ID Validation ─────────────────────────────────────────────

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_RE.test(id);
}

export function isReservedName(id: string): boolean {
  return RESERVED_NAMES.has(id);
}

// ── Label Parsing ──────────────────────────────────────────────────────

/**
 * Parse openpalm.* labels from a compose.yml file.
 * Returns labels from the first service that has them.
 */
export function parseComposeLabels(composePath: string): ComponentLabels | null {
  if (!existsSync(composePath)) return null;

  let content: string;
  try {
    content = readFileSync(composePath, "utf-8");
  } catch {
    logger.warn("Failed to read compose file", { path: composePath });
    return null;
  }

  let doc: unknown;
  try {
    doc = yamlParse(content);
  } catch {
    logger.warn("Failed to parse YAML", { path: composePath });
    return null;
  }

  if (typeof doc !== "object" || doc === null) return null;
  const root = doc as Record<string, unknown>;
  const services = root.services;
  if (typeof services !== "object" || services === null) return null;

  const serviceMap = services as Record<string, unknown>;
  for (const serviceName of Object.keys(serviceMap)) {
    const service = serviceMap[serviceName];
    if (typeof service !== "object" || service === null) continue;

    const svc = service as Record<string, unknown>;
    const labels = svc.labels;
    if (typeof labels !== "object" || labels === null) continue;

    // Normalize list-style labels (["openpalm.name=Discord", ...]) to a map
    let labelMap: Record<string, unknown>;
    if (Array.isArray(labels)) {
      labelMap = {};
      for (const entry of labels) {
        if (typeof entry === "string") {
          const eqIdx = entry.indexOf("=");
          if (eqIdx >= 0) {
            labelMap[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
          }
        }
      }
    } else {
      labelMap = labels as Record<string, unknown>;
    }

    const name = labelMap["openpalm.name"];
    const description = labelMap["openpalm.description"];

    // Both name and description are required
    if (typeof name !== "string" || typeof description !== "string") continue;

    const result: ComponentLabels = { name, description };

    const icon = labelMap["openpalm.icon"];
    if (typeof icon === "string") result.icon = icon;

    const category = labelMap["openpalm.category"];
    if (typeof category === "string") result.category = category;

    const docs = labelMap["openpalm.docs"];
    if (typeof docs === "string") result.docs = docs;

    const healthcheck = labelMap["openpalm.healthcheck"];
    if (typeof healthcheck === "string") result.healthcheck = healthcheck;

    return result;
  }

  return null;
}

// ── Component Discovery ────────────────────────────────────────────────

/**
 * Scan a directory for component subdirectories.
 * A valid component directory contains both compose.yml and .env.schema.
 */
function scanComponentDir(
  dir: string,
  source: ComponentSource
): ComponentDefinition[] {
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const components: ComponentDefinition[] = [];

  for (const name of names) {
    const componentDir = join(dir, name);
    // Skip non-directories (check by looking for compose.yml inside)
    if (!existsSync(join(componentDir, "compose.yml"))) continue;

    const composePath = join(componentDir, "compose.yml");
    const schemaPath = join(componentDir, ".env.schema");

    // .env.schema is also required
    if (!existsSync(schemaPath)) continue;

    const caddyPath = join(componentDir, ".caddy");
    const hasCaddy = existsSync(caddyPath);

    const labels = parseComposeLabels(composePath);
    if (!labels) {
      logger.warn("Component missing valid openpalm labels, skipping", {
        id: name,
        source,
        composePath,
      });
      continue;
    }

    components.push({
      id: name,
      source,
      sourceDir: componentDir,
      composePath,
      schemaPath,
      caddyPath: hasCaddy ? caddyPath : null,
      labels,
    });
  }

  return components;
}

/**
 * Discover available components from all catalog sources.
 * Priority: user-local > registry > built-in (by directory name).
 *
 * @param openpalmHome - The OPENPALM_HOME root (e.g., ~/.openpalm)
 * @param builtinDir - Optional path to built-in components directory (e.g., packages/lib/assets/components/).
 *   When omitted, no built-in components are included in the discovery results.
 */
export function discoverComponents(
  openpalmHome: string,
  builtinDir?: string
): ComponentDefinition[] {
  // Scan all three sources
  const builtinComponents = builtinDir
    ? scanComponentDir(builtinDir, "builtin")
    : [];
  const registryComponents = scanComponentDir(
    join(openpalmHome, "data", "catalog"),
    "registry"
  );
  const userLocalComponents = scanComponentDir(
    join(openpalmHome, "config", "components"),
    "user-local"
  );

  // Apply override precedence: user-local > registry > built-in
  const byId = new Map<string, ComponentDefinition>();

  for (const c of builtinComponents) {
    byId.set(c.id, c);
  }
  for (const c of registryComponents) {
    byId.set(c.id, c);
  }
  for (const c of userLocalComponents) {
    byId.set(c.id, c);
  }

  return Array.from(byId.values());
}

// ── Overlay Validation ─────────────────────────────────────────────────

/**
 * Parse a compose YAML file into a document object.
 * Returns null on any parse error.
 */
function parseComposeYaml(
  composePath: string
): Record<string, unknown> | null {
  if (!existsSync(composePath)) return null;

  let content: string;
  try {
    content = readFileSync(composePath, "utf-8");
  } catch {
    return null;
  }

  let doc: unknown;
  try {
    doc = yamlParse(content);
  } catch {
    return null;
  }

  if (typeof doc !== "object" || doc === null) return null;
  return doc as Record<string, unknown>;
}

/**
 * Validate a component's compose.yml overlay for safety.
 * Checks architectural guardrails from core-principles.md.
 */
export function validateOverlay(composePath: string): OverlayValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const doc = parseComposeYaml(composePath);
  if (!doc) {
    return { valid: false, errors: [`Failed to parse compose.yml: ${composePath}`], warnings };
  }

  const services = doc.services;
  if (typeof services !== "object" || services === null) {
    return {
      valid: false,
      errors: ["No services defined in compose.yml"],
      warnings,
    };
  }

  const serviceMap = services as Record<string, unknown>;
  let hasOpenpalmLabels = false;

  for (const serviceName of Object.keys(serviceMap)) {
    const service = serviceMap[serviceName];
    if (typeof service !== "object" || service === null) continue;
    const svc = service as Record<string, unknown>;

    // Check for openpalm labels on any service (map or list style)
    if (typeof svc.labels === "object" && svc.labels !== null) {
      if (Array.isArray(svc.labels)) {
        if (svc.labels.some((l: unknown) => typeof l === "string" && l.startsWith("openpalm.name="))) {
          hasOpenpalmLabels = true;
        }
      } else {
        const labels = svc.labels as Record<string, unknown>;
        if ("openpalm.name" in labels) hasOpenpalmLabels = true;
      }
    }

    // Check if this service name matches a core service
    const isCoreService = CORE_SERVICE_NAMES.has(serviceName);

    if (isCoreService) {
      // Component overlays extending core services should ONLY add environment keys
      const allowedCoreExtensionKeys = new Set(["environment"]);
      const svcKeys = Object.keys(svc);

      for (const key of svcKeys) {
        if (!allowedCoreExtensionKeys.has(key)) {
          errors.push(
            `Service "${serviceName}" is a core service — component overlays extending ` +
              `core services should only add "environment" keys, not "${key}"`
          );
        }
      }
    }

    // Check for vault mount violations
    if (Array.isArray(svc.volumes)) {
      for (const vol of svc.volumes) {
        const volStr = typeof vol === "string" ? vol : "";
        if (typeof vol === "object" && vol !== null) {
          const volObj = vol as Record<string, unknown>;
          const source = String(volObj.source ?? "");
          if (/vault\b/i.test(source) && !/vault\/user\.env/i.test(source)) {
            errors.push(
              `Service "${serviceName}" mounts vault/ directory — ` +
                `only admin can mount full vault`
            );
          }
        } else if (volStr && /vault\b/i.test(volStr) && !/vault\/user\.env/i.test(volStr)) {
          errors.push(
            `Service "${serviceName}" mounts vault/ directory — ` +
              `only admin can mount full vault`
          );
        }
        // Warn about variable references that may resolve to vault paths
        const checkStr = typeof vol === "string" ? vol : String((vol as Record<string, unknown>)?.source ?? "");
        if (/\$\{[^}]*[Vv][Aa][Uu][Ll][Tt][^}]*\}/.test(checkStr)) {
          warnings.push(
            `Service "${serviceName}" volume uses a variable reference that may point to vault — ` +
              `verify this does not expose the full vault directory`
          );
        }
      }
    }

    // Check for privileged mode
    if (svc.privileged === true) {
      errors.push(
        `Service "${serviceName}" uses privileged mode — ` +
          `components must not use privileged mode`
      );
    }

    // Check for dangerous capabilities
    if (Array.isArray(svc.cap_add)) {
      const dangerousCaps = new Set(["ALL", "SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "DAC_OVERRIDE"]);
      for (const cap of svc.cap_add) {
        const capStr = typeof cap === "string" ? cap.toUpperCase() : "";
        if (dangerousCaps.has(capStr)) {
          errors.push(
            `Service "${serviceName}" adds dangerous capability "${capStr}" — ` +
              `components must not use dangerous capabilities`
          );
        }
      }
    }

    // Check for dangerous host device exposure
    if (Array.isArray(svc.devices)) {
      for (const device of svc.devices) {
        const deviceStr = typeof device === "string" ? device : "";
        if (deviceStr) {
          errors.push(
            `Service "${serviceName}" exposes host device "${deviceStr}" — ` +
              `components must not expose host devices`
          );
        }
      }
    }

    // Check for Docker socket mount
    if (Array.isArray(svc.volumes)) {
      for (const vol of svc.volumes) {
        const volStr = typeof vol === "string" ? vol : "";
        const volSource = typeof vol === "object" && vol !== null
          ? String((vol as Record<string, unknown>).source ?? "")
          : volStr;
        if (volSource.includes("/var/run/docker.sock")) {
          errors.push(
            `Service "${serviceName}" mounts Docker socket — ` +
              `components must not access the Docker socket`
          );
        }
      }
    }

    // Check for direct port exposure that bypasses guardian
    // (non-core services exposing ports that could bypass guardian)
    if (!isCoreService && Array.isArray(svc.ports)) {
      for (const port of svc.ports) {
        const portStr = typeof port === "string" ? port : String(port);
        // Guardian ports are on :8080. Warn about any public port exposure.
        warnings.push(
          `Service "${serviceName}" exposes port ${portStr} — ` +
            `ensure this does not bypass guardian ingress`
        );
      }
    }
  }

  if (!hasOpenpalmLabels) {
    warnings.push(
      "No openpalm.name label found — component may not appear correctly in the admin UI"
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Env Injection Collision Detection ──────────────────────────────────

/**
 * Extract environment variable injections into core services from a compose overlay.
 * Returns a map of { targetService -> { variable -> true } }.
 */
function extractCoreEnvInjections(
  composePath: string
): Map<string, Set<string>> {
  const injections = new Map<string, Set<string>>();

  const doc = parseComposeYaml(composePath);
  if (!doc) return injections;

  const services = doc.services;
  if (typeof services !== "object" || services === null) return injections;

  const serviceMap = services as Record<string, unknown>;

  for (const serviceName of Object.keys(serviceMap)) {
    // Only look at core service extensions
    if (!CORE_SERVICE_NAMES.has(serviceName)) continue;

    const service = serviceMap[serviceName];
    if (typeof service !== "object" || service === null) continue;
    const svc = service as Record<string, unknown>;

    const env = svc.environment;
    if (typeof env !== "object" || env === null) continue;

    const vars = new Set<string>();

    if (Array.isArray(env)) {
      // environment as list: ["VAR=value", "VAR2=value2"]
      for (const entry of env) {
        if (typeof entry === "string") {
          const eqIdx = entry.indexOf("=");
          const varName = eqIdx >= 0 ? entry.slice(0, eqIdx) : entry;
          vars.add(varName);
        }
      }
    } else {
      // environment as map: { VAR: value, VAR2: value2 }
      const envMap = env as Record<string, unknown>;
      for (const varName of Object.keys(envMap)) {
        vars.add(varName);
      }
    }

    if (vars.size > 0) {
      injections.set(serviceName, vars);
    }
  }

  return injections;
}

/**
 * Check for environment variable injection collisions across enabled instances.
 * Two instances should not inject the same env var into the same core service.
 *
 * @param instances - Array of { id, dir } objects where id is the instance identifier
 *   and dir is the absolute path to the instance directory (data/components/{id}/)
 */
export function detectEnvInjectionCollisions(
  instances: Array<{ id: string; dir: string }>
): EnvInjectionCollision[] {
  // Map of "targetService:variable" -> list of instance IDs
  const seen = new Map<string, string[]>();

  for (const { id: instanceId, dir: instanceDir } of instances) {
    const composePath = join(instanceDir, "compose.yml");

    const injections = extractCoreEnvInjections(composePath);

    for (const [targetService, vars] of injections) {
      for (const variable of vars) {
        const key = `${targetService}:${variable}`;
        const existing = seen.get(key);
        if (existing) {
          existing.push(instanceId);
        } else {
          seen.set(key, [instanceId]);
        }
      }
    }
  }

  // Collect collisions (where more than one instance injects the same var)
  const collisions: EnvInjectionCollision[] = [];
  for (const [key, sources] of seen) {
    if (sources.length > 1) {
      const [targetService, variable] = key.split(":", 2);
      collisions.push({ variable, targetService, sources });
    }
  }

  return collisions;
}

// ── Enabled Instance File Format ───────────────────────────────────────

type EnabledInstancesFile = {
  instances: EnabledInstance[];
};

// ── Path Helpers ───────────────────────────────────────────────────────

function componentsDataDir(openpalmHome: string): string {
  return join(openpalmHome, "data", "components");
}

function enabledFilePath(openpalmHome: string): string {
  return join(componentsDataDir(openpalmHome), "enabled.json");
}

function componentsConfigDir(openpalmHome: string): string {
  return join(openpalmHome, "config", "components");
}

function vaultDir(openpalmHome: string): string {
  return join(openpalmHome, "vault");
}

// ── Presence-Based Fallback ────────────────────────────────────────────

/**
 * Scan data/components/ for directories containing a .env file.
 * Used as fallback when enabled.json is missing or corrupted.
 */
function discoverInstancesByPresence(openpalmHome: string): EnabledInstance[] {
  const dir = componentsDataDir(openpalmHome);
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const instances: EnabledInstance[] = [];
  for (const name of names) {
    if (!isValidInstanceId(name)) continue;
    const envPath = join(dir, name, ".env");
    if (existsSync(envPath)) {
      instances.push({
        id: name,
        component: name,
        enabled: true,
      });
    }
  }

  return instances;
}

// ── Enabled Instance Persistence ───────────────────────────────────────

/**
 * Read enabled instances from data/components/enabled.json.
 * Falls back to presence-based discovery if file is missing/corrupted.
 */
export function readEnabledInstances(openpalmHome: string): EnabledInstance[] {
  const filePath = enabledFilePath(openpalmHome);

  if (!existsSync(filePath)) {
    return discoverInstancesByPresence(openpalmHome);
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: EnabledInstancesFile = JSON.parse(raw);
    if (!Array.isArray(parsed.instances)) {
      logger.warn("enabled.json has invalid format, falling back to presence-based discovery", {
        path: filePath,
      });
      return discoverInstancesByPresence(openpalmHome);
    }
    return parsed.instances;
  } catch (err) {
    logger.warn("Failed to read enabled.json, falling back to presence-based discovery", {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return discoverInstancesByPresence(openpalmHome);
  }
}

/**
 * Write enabled instances to data/components/enabled.json.
 */
export function writeEnabledInstances(openpalmHome: string, instances: EnabledInstance[]): void {
  const dir = componentsDataDir(openpalmHome);
  mkdirSync(dir, { recursive: true });

  const filePath = enabledFilePath(openpalmHome);
  const data: EnabledInstancesFile = { instances };
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Add an instance to enabled.json. Creates the file if missing.
 * Deduplicates by instance ID — if an instance with the same ID exists, it is replaced.
 */
export function addEnabledInstance(openpalmHome: string, instance: EnabledInstance): void {
  const existing = readEnabledInstances(openpalmHome);
  const filtered = existing.filter((i) => i.id !== instance.id);
  filtered.push(instance);
  writeEnabledInstances(openpalmHome, filtered);
}

/**
 * Remove an instance from enabled.json by ID.
 * No-op if the instance is not found.
 */
export function removeEnabledInstance(openpalmHome: string, instanceId: string): void {
  const existing = readEnabledInstances(openpalmHome);
  const filtered = existing.filter((i) => i.id !== instanceId);
  writeEnabledInstances(openpalmHome, filtered);
}

/**
 * Update an instance's enabled flag in enabled.json.
 * No-op if the instance is not found.
 */
export function setInstanceEnabled(openpalmHome: string, instanceId: string, enabled: boolean): void {
  const existing = readEnabledInstances(openpalmHome);
  const updated = existing.map((i) =>
    i.id === instanceId ? { ...i, enabled } : i
  );
  writeEnabledInstances(openpalmHome, updated);
}

// ── Compose Overlay Assembly ───────────────────────────────────────────

/**
 * Build the complete docker compose args for the stack.
 *
 * Order:
 *   1. --env-file vault/system.env --env-file vault/user.env (always first)
 *   2. -f config/components/core.yml (always)
 *   3. -f config/components/admin.yml (if admin enabled)
 *   4. For each enabled instance: -f data/components/{id}/compose.yml
 *      --env-file data/components/{id}/.env
 */
export function buildComponentComposeArgs(openpalmHome: string, options?: {
  adminEnabled?: boolean;
}): string[] {
  const args: string[] = [];
  const vault = vaultDir(openpalmHome);
  const configComponents = componentsConfigDir(openpalmHome);
  const dataComponents = componentsDataDir(openpalmHome);

  // 1. Env files from vault (always first)
  const systemEnv = join(vault, "system.env");
  const userEnv = join(vault, "user.env");

  if (existsSync(systemEnv)) {
    args.push("--env-file", systemEnv);
  } else {
    logger.warn("vault/system.env not found, skipping", { path: systemEnv });
  }

  if (existsSync(userEnv)) {
    args.push("--env-file", userEnv);
  } else {
    logger.warn("vault/user.env not found, skipping", { path: userEnv });
  }

  // 2. Core compose (always)
  const coreYml = join(configComponents, "core.yml");
  if (existsSync(coreYml)) {
    args.push("-f", coreYml);
  } else {
    logger.warn("config/components/core.yml not found, skipping", { path: coreYml });
  }

  // 3. Admin compose (optional)
  if (options?.adminEnabled) {
    const adminYml = join(configComponents, "admin.yml");
    if (existsSync(adminYml)) {
      args.push("-f", adminYml);
    } else {
      logger.warn("config/components/admin.yml not found but admin is enabled, skipping", {
        path: adminYml,
      });
    }
  }

  // 4. Enabled component instances
  const instances = readEnabledInstances(openpalmHome);
  for (const instance of instances) {
    if (!instance.enabled) continue;

    const instanceDir = join(dataComponents, instance.id);
    const composeYml = join(instanceDir, "compose.yml");
    const envFile = join(instanceDir, ".env");

    if (!existsSync(composeYml)) {
      logger.warn("compose.yml not found for enabled instance, skipping", {
        instanceId: instance.id,
        path: composeYml,
      });
      continue;
    }

    args.push("-f", composeYml);

    if (existsSync(envFile)) {
      args.push("--env-file", envFile);
    }
  }

  return args;
}

// ── Dynamic Allowlist ──────────────────────────────────────────────────

/**
 * Build the set of allowed Docker service names from core + enabled instances.
 */
export function buildAllowlist(openpalmHome: string): Set<string> {
  const allowed = new Set<string>([...CORE_SERVICES, ...OPTIONAL_SERVICES]);

  const instances = readEnabledInstances(openpalmHome);
  for (const instance of instances) {
    if (instance.enabled) {
      allowed.add(`openpalm-${instance.id}`);
    }
  }

  return allowed;
}
