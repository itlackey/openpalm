import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { composeAction, composeConfigValidate, composeExec, composeServiceNames, composeLogsValidateTail } from "./compose-runner.ts";
import { computeImpactFromChanges, type StackImpact } from "./impact-plan.ts";
import { StackManager } from "./stack-manager.ts";

export type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  impact: StackImpact;
  warnings: string[];
};

const CoreRecoveryServices = ["admin", "caddy", "assistant", "gateway", "openmemory", "openmemory-ui", "postgres", "qdrant"] as const;

type ExistingArtifacts = {
  caddyJson: string;
  composeFile: string;
  systemEnv: string;
  gatewayEnv: string;
  openmemoryEnv: string;
  postgresEnv: string;
  qdrantEnv: string;
  assistantEnv: string;
  channelEnvs: Record<string, string>;
  serviceEnvs: Record<string, string>;
};

function readIfExists(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function readExistingArtifacts(manager: StackManager): ExistingArtifacts {
  const paths = manager.getPaths();

  const channelEnvs: Record<string, string> = {};
  for (const serviceName of manager.enabledChannelServiceNames()) {
    channelEnvs[serviceName] = readIfExists(join(paths.stateRootPath, serviceName, ".env"));
  }

  const serviceEnvs: Record<string, string> = {};
  for (const serviceName of manager.enabledServiceNames()) {
    serviceEnvs[serviceName] = readIfExists(join(paths.stateRootPath, serviceName, ".env"));
  }

  return {
    caddyJson: readIfExists(paths.caddyJsonPath),
    composeFile: readIfExists(paths.composeFilePath),
    systemEnv: readIfExists(paths.systemEnvPath),
    gatewayEnv: readIfExists(paths.gatewayEnvPath),
    openmemoryEnv: readIfExists(paths.openmemoryEnvPath),
    postgresEnv: readIfExists(paths.postgresEnvPath),
    qdrantEnv: readIfExists(paths.qdrantEnvPath),
    assistantEnv: readIfExists(paths.assistantEnvPath),
    channelEnvs,
    serviceEnvs,
  };
}

function writeArtifact(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function restoreArtifacts(manager: StackManager, artifacts: ExistingArtifacts): void {
  const paths = manager.getPaths();

  writeArtifact(paths.caddyJsonPath, artifacts.caddyJson);
  writeArtifact(paths.composeFilePath, artifacts.composeFile);
  writeArtifact(paths.systemEnvPath, artifacts.systemEnv);
  writeArtifact(paths.gatewayEnvPath, artifacts.gatewayEnv);
  writeArtifact(paths.openmemoryEnvPath, artifacts.openmemoryEnv);
  writeArtifact(paths.postgresEnvPath, artifacts.postgresEnv);
  writeArtifact(paths.qdrantEnvPath, artifacts.qdrantEnv);
  writeArtifact(paths.assistantEnvPath, artifacts.assistantEnv);

  for (const [serviceName, content] of Object.entries(artifacts.channelEnvs)) {
    writeArtifact(join(paths.stateRootPath, serviceName, ".env"), content);
  }

  for (const [serviceName, content] of Object.entries(artifacts.serviceEnvs)) {
    writeArtifact(join(paths.stateRootPath, serviceName, ".env"), content);
  }
}

function buildEmergencyCompose(manager: StackManager): string {
  const paths = manager.getPaths();
  return `services:
  admin:
    image: \${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:\${OPENPALM_IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file:
      - \${OPENPALM_STATE_HOME}/system.env
    environment:
      - PORT=8100
      - ADMIN_TOKEN=\${ADMIN_TOKEN:?ADMIN_TOKEN must be set}
      - OPENPALM_COMPOSE_BIN=\${OPENPALM_COMPOSE_BIN:-docker}
      - OPENPALM_COMPOSE_SUBCOMMAND=\${OPENPALM_COMPOSE_SUBCOMMAND:-compose}
      - OPENPALM_CONTAINER_SOCKET_URI=\${OPENPALM_CONTAINER_SOCKET_URI:-unix:///var/run/docker.sock}
      - COMPOSE_PROJECT_PATH=/state
      - OPENPALM_COMPOSE_FILE=docker-compose.yml
    volumes:
      - \${OPENPALM_DATA_HOME}:/data
      - \${OPENPALM_CONFIG_HOME}:/config
      - \${OPENPALM_STATE_HOME}:/state
      - \${OPENPALM_WORK_HOME:-\${HOME}/openpalm}:/work
      - \${OPENPALM_CONTAINER_SOCKET_PATH:-/var/run/docker.sock}:\${OPENPALM_CONTAINER_SOCKET_IN_CONTAINER:-/var/run/docker.sock}
    networks: [assistant_net]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "\${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:80:80"
      - "\${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:443:443"
    volumes:
      - ${paths.caddyJsonPath}:/etc/caddy/caddy.json:ro
      - \${OPENPALM_STATE_HOME}/caddy/data:/data/caddy
      - \${OPENPALM_STATE_HOME}/caddy/config:/config/caddy
    command: caddy run --config /etc/caddy/caddy.json
    depends_on:
      admin:
        condition: service_started
    networks: [assistant_net]

networks:
  assistant_net:
`;
}

async function fallbackToAdminAndCaddy(manager: StackManager): Promise<void> {
  const paths = manager.getPaths();

  writeArtifact(paths.caddyJsonPath, `${JSON.stringify({
    admin: { disabled: true },
    apps: {
      http: {
        servers: {
          main: {
            listen: [":80"],
            routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "admin:8100" }] }] }],
          },
        },
      },
    },
  }, null, 2)}\n`);

  writeArtifact(paths.composeFilePath, buildEmergencyCompose(manager));

  const validate = await composeConfigValidate();
  if (!validate.ok) throw new Error(`fallback_compose_validation_failed:${validate.stderr}`);

  const upAdmin = await composeAction("up", "admin");
  if (!upAdmin.ok) throw new Error(`fallback_compose_up_failed:admin:${upAdmin.stderr}`);

  const upCaddy = await composeAction("up", "caddy");
  if (!upCaddy.ok) throw new Error(`fallback_compose_up_failed:caddy:${upCaddy.stderr}`);
}

function enabledChannelServices(manager: StackManager): string[] {
  return manager.enabledChannelServiceNames();
}

function parseComposeServiceNames(composeContent: string): Set<string> {
  const names = new Set<string>();
  const lines = composeContent.split(/\r?\n/);
  let inServices = false;
  for (const line of lines) {
    if (!inServices) {
      if (line.trim() === "services:") inServices = true;
      continue;
    }
    if (/^[^\s#]/.test(line) && line.trim() !== "") break;
    const match = /^\s{2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function deriveImpact(manager: StackManager, existing: ExistingArtifacts, generated: ReturnType<StackManager["renderPreview"]>): StackImpact {
  const caddyChanged = existing.caddyJson !== generated.caddyJson;

  const channelEnvServices = new Set<string>([...Object.keys(existing.channelEnvs), ...Object.keys(generated.channelEnvs)]);
  const channelsEnvChanged = Array.from(channelEnvServices).some((serviceName) => (
    (existing.channelEnvs[serviceName] ?? "") !== (generated.channelEnvs[serviceName] ?? "")
  ));

  const serviceEnvNames = new Set<string>([...Object.keys(existing.serviceEnvs), ...Object.keys(generated.serviceEnvs)]);
  const serviceConfigChanged = Array.from(serviceEnvNames).filter((serviceName) => (
    (existing.serviceEnvs[serviceName] ?? "") !== (generated.serviceEnvs[serviceName] ?? "")
  ));

  const changed = {
    caddyChanged,
    gatewaySecretsChanged: existing.gatewayEnv !== generated.gatewayEnv,
    channelConfigChanged: channelsEnvChanged ? enabledChannelServices(manager) : [],
    assistantChanged: existing.assistantEnv !== generated.assistantEnv,
    openmemoryChanged:
      existing.openmemoryEnv !== generated.openmemoryEnv ||
      existing.postgresEnv !== generated.postgresEnv ||
      existing.qdrantEnv !== generated.qdrantEnv,
  };

  const impact = computeImpactFromChanges(changed);
  for (const svc of serviceConfigChanged) impact.restart.push(svc);
  if (existing.systemEnv !== generated.systemEnv) {
    impact.restart = Array.from(new Set([...impact.restart, "admin", "gateway"]));
  }
  if (existing.composeFile !== generated.composeFile) {
    impact.restart = Array.from(new Set([...impact.restart, "gateway", "assistant", "openmemory", "admin"]));

    const existingServices = parseComposeServiceNames(existing.composeFile);
    const generatedServices = parseComposeServiceNames(generated.composeFile);
    for (const svc of generatedServices) {
      if (!existingServices.has(svc)) impact.up.push(svc);
    }
  }

  const upSet = new Set(impact.up);
  impact.restart = impact.restart.filter((svc) => !upSet.has(svc));

  return impact;
}

export async function applyStack(manager: StackManager, options?: { apply?: boolean }): Promise<StackApplyResult> {
  const generated = manager.renderPreview();
  const existing = readExistingArtifacts(manager);
  const secretErrors = manager.validateReferencedSecrets();
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
    manager.renderArtifacts(generated);

    try {
      for (const service of impact.up) {
        const result = await composeAction("up", service);
        if (!result.ok) throw new Error(`compose_up_failed:${service}:${result.stderr}`);
      }
      for (const service of impact.restart) {
        const result = await composeAction("restart", service);
        if (!result.ok) throw new Error(`compose_restart_failed:${service}:${result.stderr}`);
      }
      for (const service of impact.reload) {
        if (service === "caddy") {
          const result = await composeExec("caddy", ["caddy", "reload", "--config", "/etc/caddy/caddy.json"]);
          if (!result.ok) throw new Error(`compose_reload_failed:${service}:${result.stderr}`);
          continue;
        }
        const result = await composeAction("restart", service);
        if (!result.ok) throw new Error(`compose_reload_failed:${service}:${result.stderr}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      warnings.push(`stack_apply_failed_attempting_rollback:${errorMessage}`);
      try {
        restoreArtifacts(manager, existing);
        const rollbackValidate = await composeConfigValidate();
        if (!rollbackValidate.ok) throw new Error(`rollback_compose_validation_failed:${rollbackValidate.stderr}`);
        for (const service of CoreRecoveryServices) {
          const rollbackUp = await composeAction("up", service);
          if (!rollbackUp.ok) throw new Error(`rollback_compose_up_failed:${service}:${rollbackUp.stderr}`);
        }
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        warnings.push(`rollback_failed_attempting_fallback:${rollbackMessage}`);
        await fallbackToAdminAndCaddy(manager);
      }
      throw new Error(errorMessage);
    }
  }

  return { ok: true, generated, impact, warnings };
}

export async function previewComposeOperations(): Promise<{ services: string[]; logTailLimit: boolean; reloadSemantics: Record<string, "reload" | "restart"> }> {
  const names = await composeServiceNames();
  const tailCheck = composeLogsValidateTail(50);

  const semantics: Record<string, "reload" | "restart"> = {
    caddy: "reload",
    gateway: "restart",
    "assistant": "restart",
    openmemory: "restart",
    admin: "restart",
  };

  for (const name of names) {
    if (name.startsWith("channel-") && !semantics[name]) {
      semantics[name] = "restart";
    }
    if (name.startsWith("service-") && !semantics[name]) {
      semantics[name] = "restart";
    }
  }

  return {
    services: names,
    logTailLimit: tailCheck,
    reloadSemantics: semantics,
  };
}
