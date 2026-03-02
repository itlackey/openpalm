/**
 * Registry synchronization — clones or pulls the OpenPalm registry from GitHub.
 *
 * On first call, performs a sparse checkout of just the registry/ directory.
 * On subsequent calls, does a git pull to fetch the latest changes.
 *
 * The cloned registry lives at STATE_HOME/registry/ and is the runtime
 * source of truth for available channels and automations.
 */
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveStateHome } from "./paths.js";

const REPO = "itlackey/openpalm";
const BRANCH = process.env.OPENPALM_REGISTRY_BRANCH ?? "main";
const REPO_URL =
  process.env.OPENPALM_REGISTRY_URL ??
  `https://github.com/${REPO}.git`;

// ── Registry directory resolution ───────────────────────────────────

/** Root of the cloned registry checkout inside STATE_HOME */
export function registryRoot(): string {
  return join(resolveStateHome(), "registry");
}

/** Path to the git repo clone (we clone the whole repo shallowly then read registry/) */
function repoCloneDir(): string {
  return join(resolveStateHome(), "registry-repo");
}

// ── Clone / Pull ────────────────────────────────────────────────────

/**
 * Ensure the registry repo is cloned into STATE_HOME/registry-repo/.
 * Uses sparse checkout to fetch only the registry/ directory.
 * Returns the path to the registry/ subdirectory inside the clone.
 */
export function ensureRegistryClone(): string {
  const cloneDir = repoCloneDir();
  const registryDir = join(cloneDir, "registry");

  if (existsSync(join(cloneDir, ".git"))) {
    return registryDir;
  }

  mkdirSync(cloneDir, { recursive: true });

  try {
    // Shallow clone with sparse checkout for just registry/
    execSync(
      `git clone --depth 1 --filter=blob:none --sparse --branch ${BRANCH} ${REPO_URL} .`,
      { cwd: cloneDir, stdio: "pipe", timeout: 60_000 }
    );
    execSync(`git sparse-checkout set registry`, {
      cwd: cloneDir,
      stdio: "pipe",
      timeout: 30_000
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to clone registry from ${REPO_URL}: ${msg}`);
  }

  return registryDir;
}

/**
 * Pull latest changes from the remote into the existing clone.
 * Returns true if new changes were pulled, false if already up to date.
 */
export function pullRegistry(): { updated: boolean; error?: string } {
  const cloneDir = repoCloneDir();

  if (!existsSync(join(cloneDir, ".git"))) {
    // Not cloned yet — clone first
    try {
      ensureRegistryClone();
      return { updated: true };
    } catch (err) {
      return { updated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  try {
    const result = execSync(`git pull origin ${BRANCH}`, {
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

export type RegistryChannelEntry = {
  name: string;
  type: "channel";
  description: string;
  hasRoute: boolean;
  ymlContent: string;
  caddyContent: string | null;
};

export type RegistryAutomationEntry = {
  name: string;
  type: "automation";
  description: string;
  schedule: string;
  ymlContent: string;
};

/** Strict name: lowercase alphanumeric + hyphens, 1–63 chars, starts with alnum */
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Discover channel entries from the cloned registry/channels/ directory.
 */
export function discoverRegistryChannels(): RegistryChannelEntry[] {
  const cloneDir = repoCloneDir();
  const channelsDir = join(cloneDir, "registry", "channels");
  if (!existsSync(channelsDir)) return [];

  const files = readdirSync(channelsDir);
  const ymlFiles = files.filter((f) => f.endsWith(".yml"));
  const caddyFiles = new Set(files.filter((f) => f.endsWith(".caddy")));

  return ymlFiles
    .map((ymlFile) => {
      const name = ymlFile.replace(/\.yml$/, "");
      if (!VALID_NAME_RE.test(name)) return null;

      const ymlContent = readFileSync(join(channelsDir, ymlFile), "utf-8");
      const caddyFile = `${name}.caddy`;
      const hasRoute = caddyFiles.has(caddyFile);
      const caddyContent = hasRoute
        ? readFileSync(join(channelsDir, caddyFile), "utf-8")
        : null;

      return {
        name,
        type: "channel" as const,
        description: `Docker compose service for the ${name} channel`,
        hasRoute,
        ymlContent,
        caddyContent
      };
    })
    .filter((entry): entry is RegistryChannelEntry => entry !== null);
}

/**
 * Discover automation entries from the cloned registry/automations/ directory.
 */
export function discoverRegistryAutomations(): RegistryAutomationEntry[] {
  const cloneDir = repoCloneDir();
  const automationsDir = join(cloneDir, "registry", "automations");
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
 * Get channel content from the cloned registry by name.
 */
export function getRegistryChannel(
  name: string
): { yml: string; caddy: string | null } | null {
  const cloneDir = repoCloneDir();
  const channelsDir = join(cloneDir, "registry", "channels");
  const ymlPath = join(channelsDir, `${name}.yml`);
  if (!existsSync(ymlPath)) return null;

  const yml = readFileSync(ymlPath, "utf-8");
  const caddyPath = join(channelsDir, `${name}.caddy`);
  const caddy = existsSync(caddyPath) ? readFileSync(caddyPath, "utf-8") : null;
  return { yml, caddy };
}

/**
 * Get automation content from the cloned registry by name.
 */
export function getRegistryAutomation(name: string): string | null {
  const cloneDir = repoCloneDir();
  const automationsDir = join(cloneDir, "registry", "automations");
  const ymlPath = join(automationsDir, `${name}.yml`);
  if (!existsSync(ymlPath)) return null;
  return readFileSync(ymlPath, "utf-8");
}
