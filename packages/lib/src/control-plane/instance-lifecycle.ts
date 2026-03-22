/** Instance lifecycle — create, configure, list, delete component instances. */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../logger.js";
import {
  isValidInstanceId,
  isReservedName,
  readEnabledInstances,
  addEnabledInstance,
  removeEnabledInstance,
} from "./components.js";
import type { ComponentDefinition, InstanceDetail, InstanceStatus, EnabledInstance } from "./components.js";
import { parseEnvFile } from "./env.js";
import {
  registerComponentSensitiveFields,
  deregisterComponentSensitiveFields,
} from "./component-secrets.js";

const logger = createLogger("instance-lifecycle");

function componentsDir(openpalmHome: string): string {
  return join(openpalmHome, "data", "components");
}

function instanceDir(openpalmHome: string, instanceId: string): string {
  return join(componentsDir(openpalmHome), instanceId);
}

function archiveDir(openpalmHome: string): string {
  return join(openpalmHome, "data", "archived");
}

export type EnvSchemaField = {
  name: string;
  defaultValue: string;
  required: boolean;
  sensitive: boolean;
  helpText: string;
  section: string;
};

export function parseEnvSchema(schemaPath: string): EnvSchemaField[] {
  if (!existsSync(schemaPath)) return [];

  const content = readFileSync(schemaPath, "utf-8");
  const lines = content.split("\n");
  const fields: EnvSchemaField[] = [];

  let currentSection = "";
  let pendingComments: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Section separator: # ---
    if (/^#\s*---\s*$/.test(trimmed)) {
      // The last non-empty comment before this separator is the section header
      const lastComment = pendingComments.filter((c) => c.length > 0).pop();
      if (lastComment) {
        currentSection = lastComment;
      }
      pendingComments = [];
      continue;
    }

    // Comment line
    if (trimmed.startsWith("#")) {
      const commentText = trimmed.replace(/^#\s*/, "");
      pendingComments.push(commentText);
      continue;
    }

    // Empty line — reset pending comments only if we haven't hit a field
    if (!trimmed) {
      pendingComments = [];
      continue;
    }

    // Field definition: KEY=VALUE
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;

    const name = trimmed.slice(0, eqIdx).trim();
    const defaultValue = trimmed.slice(eqIdx + 1).trim();

    // Parse annotations from pending comments
    let required = false;
    let sensitive = false;
    const helpLines: string[] = [];

    for (const comment of pendingComments) {
      if (/@required(?:\s*=\s*false)?/.test(comment) && !/@required\s*=\s*false/.test(comment)) {
        required = true;
      }
      if (/@sensitive(?:\s*=\s*false)?/.test(comment) && !/@sensitive\s*=\s*false/.test(comment)) {
        sensitive = true;
      }
      // Help text is any comment that isn't purely an annotation
      const stripped = comment.replace(/@required/g, "").replace(/@sensitive/g, "").trim();
      if (stripped) {
        helpLines.push(stripped);
      }
    }

    fields.push({
      name,
      defaultValue,
      required,
      sensitive,
      helpText: helpLines.join(" "),
      section: currentSection,
    });

    pendingComments = [];
  }

  return fields;
}

function copyDirectoryFiles(srcDir: string, destDir: string): void {
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    copyFileSync(join(srcDir, entry.name), join(destDir, entry.name));
  }
}

export function createInstance(
  openpalmHome: string,
  componentDef: ComponentDefinition,
  instanceId: string
): InstanceDetail {
  // Validate instance ID format
  if (!isValidInstanceId(instanceId)) {
    throw new Error(`Invalid instance ID: "${instanceId}". Must be lowercase alphanumeric with hyphens, 1-63 chars, starting with alnum.`);
  }

  // Explicit path traversal protection (defense-in-depth beyond regex)
  if (instanceId.includes('..') || instanceId.includes('/') || instanceId.includes('\\')) {
    throw new Error(`Instance ID "${instanceId}" contains invalid path characters.`);
  }

  // Check reserved names
  if (isReservedName(instanceId)) {
    throw new Error(`Instance ID "${instanceId}" is reserved and cannot be used.`);
  }

  // Check for existing instance
  const instDir = instanceDir(openpalmHome, instanceId);
  if (existsSync(instDir)) {
    throw new Error(`Instance "${instanceId}" already exists at ${instDir}.`);
  }

  // Create instance directory
  mkdirSync(instDir, { recursive: true });

  // Copy component source files
  copyDirectoryFiles(componentDef.sourceDir, instDir);

  // Create data/ subdirectory for persistent volumes
  const dataSubdir = join(instDir, "data");
  mkdirSync(dataSubdir, { recursive: true });

  // Build .env content
  const absInstanceDir = resolve(instDir);
  const envLines: string[] = [
    `# Instance identity — managed by OpenPalm. Do not edit.`,
    `INSTANCE_ID=${instanceId}`,
    `INSTANCE_DIR=${absInstanceDir}`,
  ];

  // Parse .env.schema for non-sensitive defaults
  const schemaPath = join(instDir, ".env.schema");
  if (existsSync(schemaPath)) {
    const fields = parseEnvSchema(schemaPath);
    registerComponentSensitiveFields(openpalmHome, instanceId, schemaPath);
    const defaults = fields.filter((f) => !f.sensitive && f.defaultValue !== "");
    if (defaults.length > 0) {
      envLines.push("");
      envLines.push("# Defaults from .env.schema");
      for (const field of defaults) {
        envLines.push(`${field.name}=${field.defaultValue}`);
      }
    }
  }

  envLines.push(""); // trailing newline
  writeFileSync(join(instDir, ".env"), envLines.join("\n"));

  // Add to enabled.json
  addEnabledInstance(openpalmHome, { id: instanceId, component: componentDef.id, enabled: true });

  logger.info("created instance", { instanceId, component: componentDef.id });

  return buildInstanceDetail(openpalmHome, instanceId, componentDef.id, true);
}

export function configureInstance(
  openpalmHome: string,
  instanceId: string,
  values: Record<string, string>
): void {
  const instDir = instanceDir(openpalmHome, instanceId);
  const envPath = join(instDir, ".env");

  if (!existsSync(instDir)) {
    throw new Error(`Instance "${instanceId}" does not exist.`);
  }

  // Validate env keys match a safe pattern
  const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const key of Object.keys(values)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid env key: "${key}". Must be alphanumeric with underscores.`);
    }
  }

  // Reject newlines/carriage returns in keys or values to prevent shell injection
  for (const [key, value] of Object.entries(values)) {
    if (key.includes('\n') || key.includes('\r') || value.includes('\n') || value.includes('\r')) {
      throw new Error(`Invalid characters in key or value for "${key}".`);
    }
  }

  // Parse existing entries
  const existing = parseEnvFile(envPath);

  // Merge new values, preserving identity vars
  const merged: Record<string, string> = { ...existing, ...values };
  // Always preserve identity vars from original
  if (existing.INSTANCE_ID) merged.INSTANCE_ID = existing.INSTANCE_ID;
  if (existing.INSTANCE_DIR) merged.INSTANCE_DIR = existing.INSTANCE_DIR;

  // Reconstruct .env file
  const lines: string[] = [
    "# Instance identity — managed by OpenPalm. Do not edit.",
    `INSTANCE_ID=${merged.INSTANCE_ID ?? instanceId}`,
    `INSTANCE_DIR=${merged.INSTANCE_DIR ?? resolve(instDir)}`,
    "",
  ];

  // Write all other entries
  for (const [key, value] of Object.entries(merged)) {
    if (key === "INSTANCE_ID" || key === "INSTANCE_DIR") continue;
    lines.push(`${key}=${value}`);
  }

  lines.push(""); // trailing newline
  writeFileSync(envPath, lines.join("\n"));

  logger.info("configured instance", { instanceId, keys: Object.keys(values) });
}

function buildInstanceDetail(
  openpalmHome: string,
  instanceId: string,
  component: string,
  enabled: boolean,
  status: InstanceStatus = "unknown"
): InstanceDetail {
  const instDir = instanceDir(openpalmHome, instanceId);

  return {
    id: instanceId,
    component,
    instanceDir: resolve(instDir),
    composePath: join(instDir, "compose.yml"),
    envPath: join(instDir, ".env"),
    schemaPath: join(instDir, ".env.schema"),
    dataDir: join(instDir, "data"),
    enabled,
    status,
  };
}

export function getInstanceDetail(
  openpalmHome: string,
  instanceId: string
): InstanceDetail | null {
  const instDir = instanceDir(openpalmHome, instanceId);
  if (!existsSync(instDir)) return null;

  // Try to determine component name from enabled.json
  const enabledInstances = readEnabledInstances(openpalmHome);
  const entry = enabledInstances.find((i) => i.id === instanceId);

  // If not in enabled.json, component remains "unknown"
  const component = entry?.component ?? "unknown";
  const enabled = entry?.enabled ?? false;

  return buildInstanceDetail(openpalmHome, instanceId, component, enabled);
}

export function listInstances(openpalmHome: string): InstanceDetail[] {
  const compDir = componentsDir(openpalmHome);
  if (!existsSync(compDir)) return [];

  const enabledInstances = readEnabledInstances(openpalmHome);
  const enabledMap = new Map(enabledInstances.map((i) => [i.id, i]));

  const results: InstanceDetail[] = [];

  // Scan instance directories
  let names: string[];
  try {
    names = readdirSync(compDir);
  } catch {
    return [];
  }

  for (const name of names) {
    // Skip non-directory entries and the enabled.json file
    if (name === "enabled.json") continue;
    const instDir = join(compDir, name);
    if (!existsSync(join(instDir, "compose.yml"))) continue;

    const enabledEntry = enabledMap.get(name);
    const component = enabledEntry?.component ?? "unknown";
    const enabled = enabledEntry?.enabled ?? false;

    results.push(buildInstanceDetail(openpalmHome, name, component, enabled));
  }

  return results;
}

export function deleteInstance(openpalmHome: string, instanceId: string): void {
  const instDir = instanceDir(openpalmHome, instanceId);
  if (!existsSync(instDir)) {
    throw new Error(`Instance "${instanceId}" does not exist.`);
  }

  // Archive the instance directory
  const archDir = archiveDir(openpalmHome);
  mkdirSync(archDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archDir, `${instanceId}-${timestamp}`);
  renameSync(instDir, archivePath);

  // Remove from enabled.json
  removeEnabledInstance(openpalmHome, instanceId);
  deregisterComponentSensitiveFields(openpalmHome, instanceId);

  logger.info("deleted instance", { instanceId, archivedTo: archivePath });
}

