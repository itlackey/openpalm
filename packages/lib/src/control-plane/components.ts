/** Unified component system — discovery, instances, compose overlay assembly. */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { CORE_SERVICES, OPTIONAL_SERVICES } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("components");

export type ComponentDefinition = {
  id: string;                    // directory name (e.g., "discord")
  source: ComponentSource;       // where it came from
  sourceDir: string;             // absolute path to source directory
  composePath: string;           // absolute path to compose.yml
  schemaPath: string;            // absolute path to .env.schema
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
  dataDir: string;               // absolute path to instance data/ subdirectory
  status: InstanceStatus;
};

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESERVED_NAMES = new Set<string>([
  ...CORE_SERVICES,
  ...OPTIONAL_SERVICES,
]);

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_RE.test(id);
}

export function isReservedName(id: string): boolean {
  return RESERVED_NAMES.has(id);
}

/** Parse openpalm.* labels from a compose.yml file. Exported for testing. */
export function parseComposeLabels(composePath: string): ComponentLabels | null {
  if (!existsSync(composePath)) return null;
  let doc: unknown;
  try {
    doc = yamlParse(readFileSync(composePath, "utf-8"));
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const docObj = doc as Record<string, unknown>;

  const services = docObj.services;
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
      labels,
    });
  }

  return components;
}

/** Discover available components. Priority: registry > built-in. */
export function discoverComponents(
  openpalmHome: string,
  builtinDir?: string
): ComponentDefinition[] {
  const builtinComponents = builtinDir
    ? scanComponentDir(builtinDir, "builtin")
    : [];
  const registryComponents = scanComponentDir(
    join(openpalmHome, "data", "catalog"),
    "registry"
  );

  // Apply override precedence: registry > built-in
  const byId = new Map<string, ComponentDefinition>();

  for (const c of builtinComponents) {
    byId.set(c.id, c);
  }
  for (const c of registryComponents) {
    byId.set(c.id, c);
  }

  return Array.from(byId.values());
}

type EnabledInstancesFile = {
  instances: EnabledInstance[];
};

function componentsDataDir(openpalmHome: string): string {
  return join(openpalmHome, "data", "components");
}

function enabledFilePath(openpalmHome: string): string {
  return join(componentsDataDir(openpalmHome), "enabled.json");
}

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

function writeEnabledInstances(openpalmHome: string, instances: EnabledInstance[]): void {
  const dir = componentsDataDir(openpalmHome);
  mkdirSync(dir, { recursive: true });

  const filePath = enabledFilePath(openpalmHome);
  const data: EnabledInstancesFile = { instances };
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function addEnabledInstance(openpalmHome: string, instance: EnabledInstance): void {
  const existing = readEnabledInstances(openpalmHome);
  const filtered = existing.filter((i) => i.id !== instance.id);
  filtered.push(instance);
  writeEnabledInstances(openpalmHome, filtered);
}

export function removeEnabledInstance(openpalmHome: string, instanceId: string): void {
  const existing = readEnabledInstances(openpalmHome);
  const filtered = existing.filter((i) => i.id !== instanceId);
  writeEnabledInstances(openpalmHome, filtered);
}

/** Build compose args: core env files + core compose files + enabled instance overlays. */
export function buildComponentComposeArgs(openpalmHome: string, options: {
  /** Canonical compose files from buildComposeFileList() — required. */
  coreFiles: string[];
  /** Canonical env files from buildEnvFiles() — required. */
  coreEnvFiles: string[];
}): string[] {
  const args: string[] = [];
  const dataComponents = componentsDataDir(openpalmHome);

  // 1. Env files from canonical resolver
  for (const ef of options.coreEnvFiles) {
    if (existsSync(ef)) args.push("--env-file", ef);
  }

  // 2. Core compose files from canonical resolver
  for (const f of options.coreFiles) {
    if (existsSync(f)) args.push("-f", f);
  }

  // 3. Enabled component instance overlays
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
