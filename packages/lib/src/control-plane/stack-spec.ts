/**
 * Stack specification file (openpalm.yaml) management.
 *
 * The stack spec is a YAML document that captures the high-level
 * configuration of an OpenPalm installation: connections, capability
 * assignments, and feature flags. It lives in CONFIG_HOME.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

// ── Types ──────────────────────────────────────────────────────────────

export type StackSpecConnection = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
};

export type StackSpecAssignments = {
  llm: { connectionId: string; model: string; smallModel?: string };
  embeddings: { connectionId: string; model: string; embeddingDims?: number };
};

export type StackSpec = {
  version: 3;
  connections: StackSpecConnection[];
  assignments: StackSpecAssignments;
  ollamaEnabled: boolean;
};

// ── Constants ──────────────────────────────────────────────────────────

export const STACK_SPEC_FILENAME = "openpalm.yaml";

// ── Read / Write ────────────────────────────────────────────────────────

export function stackSpecPath(configDir: string): string {
  return `${configDir}/${STACK_SPEC_FILENAME}`;
}

export function writeStackSpec(configDir: string, spec: StackSpec): void {
  mkdirSync(configDir, { recursive: true });
  const content = yamlStringify(spec, { indent: 2 });
  writeFileSync(stackSpecPath(configDir), content);
}

export function readStackSpec(configDir: string): StackSpec | null {
  const path = stackSpecPath(configDir);
  if (!existsSync(path)) return null;
  const raw = yamlParse(readFileSync(path, "utf-8")) as unknown;
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 3) return null;
  return obj as unknown as StackSpec;
}
