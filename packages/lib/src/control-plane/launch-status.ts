/**
 * Launch status — the single source of truth for "what state is the local stack
 * in, what remotes are reachable, and where should the app land the user."
 *
 * Replaces the binary `isSetupComplete()` for routing decisions. The keystone is
 * the PURE `deriveLaunchStatus()` — it takes already-collected facts and produces
 * the authoritative `recommendedRoute`, so the routing table is exhaustively
 * unit-testable with no I/O. The UI and CLI both collect their facts (local
 * install state from disk, container health, remote reachability) and feed them
 * through this one function, so neither duplicates the routing logic.
 *
 * Routing rule (authoritative, from #440):
 *   recommendedRoute === 'chat'  IFF  hasHealthyLocal
 *                                     OR (local is not_installed AND a remote is accessible)
 *   every other case → 'splash'   — crucially, an INSTALLED-but-unhealthy local
 *   stack routes to the splash even when a healthy remote exists, so a broken
 *   local install always gets the user's attention instead of being silently
 *   routed around.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { parseEnvFile } from "./env.js";
import { stackEnvPathFromStackDir } from "./paths.js";
import { checkDocker, checkDockerCompose } from "./docker.js";
import { SKELETON_VERSION_STAMP } from "./ui-assets.js";

export type LocalStackState =
  | "not_installed"     // nothing installed — offer install / add remote
  | "setup_incomplete"  // install started, OP_SETUP_COMPLETE not set
  | "installed_offline" // setup complete, stack not running
  | "installed_broken"  // setup complete, running but unhealthy / config error
  | "running";          // healthy

export type RemoteReachability = "accessible" | "unreachable" | "unauthorized" | "unknown";

export interface RuntimeInfo {
  /** A container runtime (Docker or a compatible engine) responded. */
  dockerPresent: boolean;
  /** Reported server version when present. */
  dockerVersion?: string;
  /** `docker compose` (or equivalent) is usable. */
  composeAvailable: boolean;
  /** Human-facing runtime flavor when detectable. */
  runtimeName?: "Docker" | "OrbStack" | "Podman";
}

export function detectRuntimeName(versionOutput: string): RuntimeInfo["runtimeName"] {
  if (/orbstack/i.test(versionOutput)) return "OrbStack";
  if (/podman/i.test(versionOutput)) return "Podman";
  if (versionOutput.trim().length > 0) return "Docker";
  return undefined;
}

async function readRuntimeIdentity(): Promise<string> {
  return new Promise((resolve) => {
    execFile("docker", ["version"], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) return resolve("");
      resolve(`${stdout?.toString() ?? ""}\n${stderr?.toString() ?? ""}`.trim());
    });
  });
}

export interface RemoteStatus {
  id: string;
  name: string;
  url: string;
  state: RemoteReachability;
  detail?: string;
}

export interface LocalStatus {
  state: LocalStackState;
  detail?: Record<string, unknown>;
  /** Present (and meaningful) when nothing is installed: can the user install? */
  runtime?: RuntimeInfo;
  /** Skeleton version mismatch alert (when OP_HOME was seeded from a different release). */
  skeletonMismatch?: { expected: string; actual: string };
}

export type ComposeServiceStatus = {
  service: string;
  state: string;
  health: string;
};

export type ActiveAssistant = { kind: "local" } | { kind: "remote"; id: string } | null;

export interface LaunchStatus {
  local: LocalStatus;
  remotes: RemoteStatus[];
  // Convenience derivations used by the router:
  hasHealthyLocal: boolean;
  localInstalledButUnhealthy: boolean;
  hasAccessibleRemote: boolean;
  recommendedRoute: "chat" | "splash";
  /** Which assistant to default to when routing to chat (null on splash). */
  activeAssistant: ActiveAssistant;
  /** Non-blocking alerts to show when routing to chat (e.g. other dead remotes). */
  alerts: string[];
}

/** Local states that mean "installed, but the user needs to act" → always splash. */
const INSTALLED_UNHEALTHY: readonly LocalStackState[] = [
  "setup_incomplete",
  "installed_offline",
  "installed_broken",
];

/**
 * Pure routing derivation. No I/O — give it the collected facts, get the route.
 * This is the function with exhaustive table tests.
 */
export function deriveLaunchStatus(input: { local: LocalStatus; remotes?: RemoteStatus[] }): LaunchStatus {
  const remotes = input.remotes ?? [];
  const state = input.local.state;

  const hasHealthyLocal = state === "running";
  const localInstalledButUnhealthy = INSTALLED_UNHEALTHY.includes(state);
  const accessibleRemotes = remotes.filter((r) => r.state === "accessible");
  const hasAccessibleRemote = accessibleRemotes.length > 0;

  // Authoritative rule. Note: an installed-but-unhealthy local NEVER routes to
  // chat, even with a healthy remote — it falls through to splash.
  const recommendedRoute: "chat" | "splash" =
    hasHealthyLocal || (state === "not_installed" && hasAccessibleRemote) ? "chat" : "splash";

  let activeAssistant: ActiveAssistant = null;
  if (recommendedRoute === "chat") {
    activeAssistant = hasHealthyLocal ? { kind: "local" } : { kind: "remote", id: accessibleRemotes[0]!.id };
  }

  // When landing on chat, surface every OTHER failure as a non-blocking alert.
  const alerts: string[] = [];
  if (recommendedRoute === "chat") {
    for (const r of remotes) {
      if (r.state === "unreachable" || r.state === "unauthorized") {
        alerts.push(`Remote connection "${r.name}" is ${r.state}${r.detail ? `: ${r.detail}` : ""}`);
      }
    }
  }

  return {
    local: input.local,
    remotes,
    hasHealthyLocal,
    localInstalledButUnhealthy,
    hasAccessibleRemote,
    recommendedRoute,
    activeAssistant,
    alerts,
  };
}

/**
 * Classify the on-disk local install WITHOUT a live health probe:
 *   - not_installed:    no materialized stack (no core.compose.yml)
 *   - setup_incomplete: stack present but OP_SETUP_COMPLETE !== 'true'
 *   - installed:        OP_SETUP_COMPLETE === 'true' (caller maps to
 *                       running/offline/broken via a container-health probe)
 *
 * Edge case (deliberate): OP_SETUP_COMPLETE === 'true' with core.compose.yml
 * MISSING still classifies as "installed" — the user DID complete setup, and
 * the subsequent health probe will surface the damage as offline/broken,
 * which routes to the splash with the install's attention-needed state rather
 * than silently restarting the wizard over their config.
 */
export function classifyLocalInstall(stackDir: string): "not_installed" | "setup_incomplete" | "installed" {
  const hasCompose = existsSync(join(stackDir, "core.compose.yml"));
  const env = parseEnvFile(stackEnvPathFromStackDir(stackDir));
  if (!hasCompose && env.OP_SETUP_COMPLETE !== "true") return "not_installed";
  if (env.OP_SETUP_COMPLETE === "true") return "installed";
  return "setup_incomplete";
}

/** Check if the OP_HOME skeleton was seeded from a different release. */
export function checkSkeletonMismatch(stackDir: string): { expected: string; actual: string } | null {
  const homeDir = join(stackDir, "..", "..");
  const stampPath = join(homeDir, SKELETON_VERSION_STAMP);
  if (!existsSync(stampPath)) return null;
  let actual: string;
  try {
    actual = readFileSync(stampPath, "utf-8").trim();
  } catch {
    return null;
  }
  const env = parseEnvFile(stackEnvPathFromStackDir(stackDir));
  // OP_RELEASE_VERSION is the migration stamp; OP_ASSISTANT_VERSION is the
  // version-of-record image tag (no single OP_IMAGE_TAG cascade anymore).
  const expected = env.OP_RELEASE_VERSION ?? env.OP_ASSISTANT_VERSION ?? "";
  if (!expected || expected === actual) return null;
  return { expected, actual };
}

export function deriveLocalStackState(
  installState: 'not_installed' | 'setup_incomplete' | 'installed',
  services: ComposeServiceStatus[],
): LocalStackState {
  if (installState === 'not_installed') return 'not_installed';
  if (services.length === 0) return installState === 'setup_incomplete' ? 'setup_incomplete' : 'installed_offline';
  const anyRunning = services.some((service) => service.state === 'running');
  const anyBroken = services.some((service) => service.state === 'exited' || service.state === 'dead' || service.health === 'unhealthy');
  const anyStarting = services.some((service) => service.health === 'starting');
  if (installState === 'setup_incomplete') {
    return anyRunning || anyStarting ? 'running' : 'setup_incomplete';
  }
  if (anyBroken) return 'installed_broken';
  if (anyRunning) return 'running';
  return 'installed_offline';
}

/** Detect the host container runtime — meaningful for the not_installed splash. */
export async function detectRuntime(): Promise<RuntimeInfo> {
  const [docker, compose] = await Promise.all([checkDocker(), checkDockerCompose()]);
  const version = docker.ok ? docker.stdout.trim() : "";
  const identity = docker.ok ? await readRuntimeIdentity() : "";
  return {
    dockerPresent: docker.ok,
    dockerVersion: version.length > 0 ? version : undefined,
    composeAvailable: compose.ok,
    runtimeName: detectRuntimeName(identity),
  };
}
