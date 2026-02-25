import type { InstallMetadata, InstallEvent, ContainerPlatform } from "./types.ts";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const METADATA_FILENAME = "install-metadata.json";
const CURRENT_SCHEMA_VERSION = 1;

export function metadataPath(stateDir: string): string {
  return join(stateDir, METADATA_FILENAME);
}

export function readInstallMetadata(stateDir: string): InstallMetadata | null {
  const path = metadataPath(stateDir);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isValidMetadata(parsed)) return null;
    return parsed as unknown as InstallMetadata;
  } catch {
    return null;
  }
}

export function writeInstallMetadata(
  stateDir: string,
  metadata: InstallMetadata,
): void {
  const path = metadataPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const content = JSON.stringify(metadata, null, 2) + "\n";
  writeFileSync(path, content, "utf8");
}

export function createInstallMetadata(options: {
  mode: InstallMetadata["mode"];
  runtime: ContainerPlatform;
  port: number;
  version?: string;
}): InstallMetadata {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    mode: options.mode,
    installedAt: now,
    runtime: options.runtime,
    port: options.port,
    version: options.version,
    history: [
      {
        action: "install",
        timestamp: now,
        version: options.version,
      },
    ],
  };
}

export function appendMetadataEvent(
  metadata: InstallMetadata,
  event: InstallEvent,
): InstallMetadata {
  return {
    ...metadata,
    lastUpdatedAt: event.timestamp,
    history: [...metadata.history, event],
  };
}

function isValidMetadata(value: Record<string, unknown>): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (value.schemaVersion !== CURRENT_SCHEMA_VERSION) return false;
  if (typeof value.mode !== "string") return false;
  if (typeof value.installedAt !== "string") return false;
  if (typeof value.runtime !== "string") return false;
  if (typeof value.port !== "number") return false;
  if (!Array.isArray(value.history)) return false;
  return true;
}
