import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { composeAction, composeConfigValidate, composeExec, composeServiceNames, composeLogsValidateTail } from "./compose-runner.ts";
import { computeImpactFromChanges, type StackImpact } from "./impact-plan.ts";
import { StackManager } from "./stack-manager.ts";
import type { StackChannelName } from "./stack-spec.ts";

export type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  impact: StackImpact;
  warnings: string[];
};

type ExistingArtifacts = {
  caddyfile: string;
  caddyRoutes: Record<string, string>;
  composeFile: string;
  gatewayEnv: string;
  openmemoryEnv: string;
  postgresEnv: string;
  qdrantEnv: string;
  opencodeEnv: string;
  channelsEnv: string;
};

function readIfExists(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function listRouteFiles(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...listRouteFiles(join(root, entry.name), next));
    if (entry.isFile() && entry.name.endsWith(".caddy")) names.push(next);
  }
  return names;
}

function readExistingArtifacts(manager: StackManager): ExistingArtifacts {
  const paths = manager.getPaths();
  const routeFiles = listRouteFiles(paths.caddyRoutesDir);
  const caddyRoutes: Record<string, string> = {};
  for (const routeFile of routeFiles) {
    caddyRoutes[routeFile] = readIfExists(join(paths.caddyRoutesDir, routeFile));
  }

  return {
    caddyfile: readIfExists(paths.caddyfilePath),
    caddyRoutes,
    composeFile: readIfExists(paths.composeFilePath),
    gatewayEnv: readIfExists(paths.gatewayEnvPath),
    openmemoryEnv: readIfExists(paths.openmemoryEnvPath),
    postgresEnv: readIfExists(paths.postgresEnvPath),
    qdrantEnv: readIfExists(paths.qdrantEnvPath),
    opencodeEnv: readIfExists(paths.opencodeEnvPath),
    channelsEnv: readIfExists(paths.channelsEnvPath),
  };
}

function caddyRoutesChanged(previous: Record<string, string>, next: Record<string, string>): boolean {
  const keys = new Set<string>([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if ((previous[key] ?? "") !== (next[key] ?? "")) return true;
  }
  return false;
}

function enabledChannelServices(manager: StackManager): string[] {
  const spec = manager.getSpec();
  const channelNames: StackChannelName[] = ["chat", "discord", "voice", "telegram"];
  return channelNames
    .filter((channel) => spec.channels[channel].enabled)
    .map((channel) => `channel-${channel}`);
}

function deriveImpact(manager: StackManager, existing: ExistingArtifacts, generated: ReturnType<StackManager["renderPreview"]>): StackImpact {
  const caddyChanged =
    existing.caddyfile !== generated.caddyfile ||
    caddyRoutesChanged(existing.caddyRoutes, generated.caddyRoutes);

  const channelsEnvChanged = existing.channelsEnv !== generated.channelsEnv;

  const changed = {
    caddyChanged,
    gatewaySecretsChanged: existing.gatewayEnv !== generated.gatewayEnv,
    channelConfigChanged: channelsEnvChanged ? enabledChannelServices(manager) : [],
    opencodeChanged: existing.opencodeEnv !== generated.opencodeEnv,
    openmemoryChanged:
      existing.openmemoryEnv !== generated.openmemoryEnv ||
      existing.postgresEnv !== generated.postgresEnv ||
      existing.qdrantEnv !== generated.qdrantEnv,
  };

  const impact = computeImpactFromChanges(changed);
  if (existing.composeFile !== generated.composeFile) {
    impact.restart = Array.from(new Set([...impact.restart, "gateway", "opencode-core", "openmemory", "admin"]));
  }
  return impact;
}

export async function applyStack(manager: StackManager, options?: { apply?: boolean }): Promise<StackApplyResult> {
  const generated = manager.renderPreview();
  const existing = readExistingArtifacts(manager);
  const secretErrors = manager.validateEnabledChannelSecrets();
  if (secretErrors.length > 0) {
    throw new Error(`secret_validation_failed:${secretErrors.join(",")}`);
  }

  const warnings: string[] = [];
  if (options?.apply ?? true) {
    const composeValidate = await composeConfigValidate();
    if (!composeValidate.ok) throw new Error(`compose_validation_failed:${composeValidate.stderr}`);
  }

  const impact = deriveImpact(manager, existing, generated);

  if (options?.apply ?? true) {
    manager.renderArtifacts();
    for (const service of impact.restart) {
      const result = await composeAction("restart", service);
      if (!result.ok) throw new Error(`compose_restart_failed:${service}:${result.stderr}`);
    }
    for (const service of impact.reload) {
      if (service === "caddy") {
        const result = await composeExec("caddy", ["caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]);
        if (!result.ok) throw new Error(`compose_reload_failed:${service}:${result.stderr}`);
        continue;
      }
      const result = await composeAction("restart", service);
      if (!result.ok) throw new Error(`compose_reload_failed:${service}:${result.stderr}`);
    }
  }

  return { ok: true, generated, impact, warnings };
}

export async function previewComposeOperations(): Promise<{ services: string[]; logTailLimit: boolean; reloadSemantics: Record<string, "reload" | "restart"> }> {
  const names = await composeServiceNames();
  const tailCheck = composeLogsValidateTail(50);
  return {
    services: names,
    logTailLimit: tailCheck,
    reloadSemantics: {
      caddy: "reload",
      gateway: "restart",
      "opencode-core": "restart",
      openmemory: "restart",
      admin: "restart",
      "channel-chat": "restart",
      "channel-discord": "restart",
      "channel-voice": "restart",
      "channel-telegram": "restart",
    },
  };
}
