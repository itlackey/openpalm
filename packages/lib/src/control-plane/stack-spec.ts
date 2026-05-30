/**
 * Stack specification file (stack.yml) management.
 *
 * The stack spec is a YAML document used as a version marker for the
 * OpenPalm installation schema. AI provider configuration lives in
 * config/akm/config.json (managed via the admin AKM tab).
 *
 * v2: capabilities removed — LLM/embedding now live in akm config.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

// ── StackSpec v2 ────────────────────────────────────────────────────────

export type StackSpec = {
  version: 2;
  addons?: string[];
};

const ADDON_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// ── Constants ───────────────────────────────────────────────────────────

export const STACK_SPEC_FILENAME = "stack.yml";

export const SPEC_DEFAULTS = {
  ports: {
    assistant: 3800,
    admin: 3880,
    adminOpencode: 3881,
    guardian: 3899,
    assistantSsh: 2222,
  },
  image: {
    namespace: "openpalm",
    tag: "latest",
  },
} as const;

// ── Read / Write ────────────────────────────────────────────────────────

export function writeStackSpec(configDir: string, spec: StackSpec): void {
  mkdirSync(configDir, { recursive: true });
  const content = yamlStringify(spec, { indent: 2 });
  writeFileSync(`${configDir}/${STACK_SPEC_FILENAME}`, content);
}

/**
 * Read the stack spec. Returns null for missing or corrupt files.
 * Only the version field is checked; legacy capability fields are ignored.
 */
export function readStackSpec(configDir: string): StackSpec | null {
  const path = `${configDir}/${STACK_SPEC_FILENAME}`;
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
  const spec: StackSpec = { version: 2 };
  if (Array.isArray(obj.addons)) {
    const addons = obj.addons
      .filter((value): value is string => typeof value === 'string' && ADDON_NAME_RE.test(value))
      .filter((value, index, all) => all.indexOf(value) === index)
      .sort();
    if (addons.length > 0) spec.addons = addons;
  }
  return spec;
}

export function listStackSpecAddons(configDir: string): string[] {
  return readStackSpec(configDir)?.addons ?? [];
}

export function setStackSpecAddon(configDir: string, name: string, enabled: boolean): void {
  if (!ADDON_NAME_RE.test(name)) throw new Error(`Invalid addon name: ${name}`);
  const current = readStackSpec(configDir) ?? { version: 2 };
  const addons = new Set(current.addons ?? []);
  if (enabled) addons.add(name);
  else addons.delete(name);
  const next: StackSpec = { version: 2 };
  const sorted = [...addons].sort();
  if (sorted.length > 0) next.addons = sorted;
  writeStackSpec(configDir, next);
}
