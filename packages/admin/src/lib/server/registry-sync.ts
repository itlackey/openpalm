/**
 * Registry synchronization — clones or pulls the OpenPalm stack from GitHub.
 *
 * On first call, performs a sparse checkout of just the stack/ directory.
 * On subsequent calls, does a git pull to fetch the latest changes.
 *
 * The cloned repo lives at cache directory/registry-repo/ and is the runtime
 * source of truth for available addons and automations automations.
 *
 * Security: all git operations use execFileSync (no shell) with validated inputs.
 */
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RegistryComponentEntry } from "@openpalm/lib";
import { resolveCacheHome } from "./paths.js";

const REPO = "itlackey/openpalm";
const REPO_URL =
  process.env.OP_REGISTRY_URL ??
  `https://github.com/${REPO}.git`;

/** Validate branch name: alphanumeric, hyphens, underscores, dots, slashes. Rejects '..' sequences. */
const BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
const BRANCH = (() => {
  const b = process.env.OP_REGISTRY_BRANCH ?? "main";
  if (!BRANCH_RE.test(b)) throw new Error(`Invalid registry branch name: ${b}`);
  if (b.includes("..")) throw new Error(`Invalid registry branch name (contains '..'): ${b}`);
  return b;
})();

/** Validate URL: must start with https:// or git@ */
const URL_RE = /^(https:\/\/|git@)/;
if (!URL_RE.test(REPO_URL)) {
  throw new Error(`Invalid registry URL: ${REPO_URL}`);
}

// ── Registry directory resolution ───────────────────────────────────

/** Root of the cloned registry checkout inside cache dir */
export function registryRoot(): string {
  return join(resolveCacheHome(), "registry");
}

/** Path to the git repo clone (we clone the whole repo shallowly then read stack/) */
function repoCloneDir(): string {
  return join(resolveCacheHome(), "registry-repo");
}

// ── Clone / Pull ────────────────────────────────────────────────────

/**
 * Ensure the repo is cloned into cache directory/registry-repo/.
 * Uses sparse checkout to fetch only the stack/ directory.
 * Returns the path to the stack/ subdirectory inside the clone.
 */
export function ensureRegistryClone(): string {
  const cloneDir = repoCloneDir();
  const stackDir = join(cloneDir, "stack");

  if (existsSync(join(cloneDir, ".git"))) {
    return stackDir;
  }

  mkdirSync(cloneDir, { recursive: true });

  try {
    execFileSync("git", [
      "clone", "--depth", "1", "--filter=blob:none", "--sparse",
      "--branch", BRANCH, REPO_URL, "."
    ], { cwd: cloneDir, stdio: "pipe", timeout: 60_000 });

    execFileSync("git", ["sparse-checkout", "set", "stack"], {
      cwd: cloneDir,
      stdio: "pipe",
      timeout: 30_000
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to clone registry from ${REPO_URL}: ${msg}`);
  }

  return stackDir;
}

/**
 * Pull latest changes from the remote into the existing clone.
 * Returns true if new changes were pulled, false if already up to date.
 */
export function pullRegistry(): { updated: boolean; error?: string } {
  const cloneDir = repoCloneDir();

  if (!existsSync(join(cloneDir, ".git"))) {
    try {
      ensureRegistryClone();
      return { updated: true };
    } catch (err) {
      return { updated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  try {
    const result = execFileSync("git", ["pull", "origin", BRANCH], {
      cwd: cloneDir,
      stdio: "pipe",
      timeout: 60_000,
      encoding: "utf-8"
    });
    const updated = !result.includes("Already up to date");
    return { updated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { updated: false, error: `Failed to pull registry: ${msg}` };
  }
}

// ── Registry item discovery ─────────────────────────────────────────

// Re-export canonical type from lib for consumers that import from this module
export type { RegistryComponentEntry } from "@openpalm/lib";

export type RegistryAutomationEntry = {
  name: string;
  type: "automation";
  description: string;
  schedule: string;
  ymlContent: string;
};

/** Strict name: lowercase alphanumeric + hyphens, 1-63 chars, starts with alnum */
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Discover addon entries from the cloned .openpalm/stack/addons/ directory.
 * Each addon is a subdirectory containing compose.yml and .env.schema.
 */
export function discoverRegistryComponents(): Record<string, RegistryComponentEntry> {
  const cloneDir = repoCloneDir();
  const addonsDir = join(cloneDir, ".openpalm", "stack", "addons");
  if (!existsSync(addonsDir)) return {};

  const entries = readdirSync(addonsDir, { withFileTypes: true });
  const result: Record<string, RegistryComponentEntry> = {};

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!VALID_NAME_RE.test(id)) continue;

    const composeFile = join(addonsDir, id, "compose.yml");
    const schemaFile = join(addonsDir, id, ".env.schema");
    if (!existsSync(composeFile) || !existsSync(schemaFile)) continue;

    const compose = readFileSync(composeFile, "utf-8");
    const schema = readFileSync(schemaFile, "utf-8");

    result[id] = { compose, schema };
  }

  return result;
}

/**
 * Discover automation entries from the cloned .openpalm/config/automations/ directory.
 */
export function discoverRegistryAutomations(): RegistryAutomationEntry[] {
  const cloneDir = repoCloneDir();
  const automationsDir = join(cloneDir, ".openpalm", "config", "automations");
  if (!existsSync(automationsDir)) return [];

  const files = readdirSync(automationsDir).filter((f) => f.endsWith(".yml"));

  return files
    .map((ymlFile) => {
      const name = ymlFile.replace(/\.yml$/, "");
      if (!VALID_NAME_RE.test(name)) return null;

      const ymlContent = readFileSync(join(automationsDir, ymlFile), "utf-8");

      let description = "";
      let schedule = "";
      try {
        const parsed = parseYaml(ymlContent);
        if (parsed && typeof parsed === "object") {
          description = parsed.description ?? "";
          schedule = parsed.schedule ?? "";
        }
      } catch {
        // best-effort
      }

      return {
        name,
        type: "automation" as const,
        description,
        schedule,
        ymlContent
      };
    })
    .filter((entry): entry is RegistryAutomationEntry => entry !== null);
}

/**
 * Get automation content from the cloned automations by name.
 */
export function getRegistryAutomation(name: string): string | null {
  if (!VALID_NAME_RE.test(name)) return null;
  const cloneDir = repoCloneDir();
  const automationsDir = join(cloneDir, ".openpalm", "config", "automations");
  const ymlPath = join(automationsDir, `${name}.yml`);
  if (!existsSync(ymlPath)) return null;
  return readFileSync(ymlPath, "utf-8");
}
