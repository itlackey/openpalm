import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  composeActionWithOverride,
  composeActionForFileWithOverride,
  composeConfigServicesWithOverride,
  composeConfigValidateForFileWithOverride,
  composeExecWithOverride,
  computeDriftReport,
} from "./compose-runner.ts";
import { pollUntilHealthy, resolveServiceHealthConfig } from "./health-gate.ts";
import { computeImpactFromChanges, diffServiceSets, type StackImpact } from "./impact-plan.ts";
import { StackManager } from "./stack-manager.ts";
import { validateFallbackBundle } from "./fallback-bundle.ts";
import { runApplyPreflight } from "./preflight-checks.ts";

export type RolloutMode = "safe" | "fast";

export type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  impact: StackImpact;
  warnings: string[];
  preflightWarnings?: string[];
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

async function fallbackToAdminAndCaddy(manager: StackManager): Promise<void> {
  const paths = manager.getPaths();
  const fallbackComposeFile = paths.fallbackComposeFilePath ?? "docker-compose-fallback.yml";

  const fallbackCaddyJsonPath = paths.fallbackCaddyJsonPath ?? join(paths.stateRootPath, "caddy-fallback.json");
  const validation = validateFallbackBundle({ composePath: fallbackComposeFile, caddyPath: fallbackCaddyJsonPath });
  if (!validation.ok) throw new Error(`fallback_bundle_integrity_failed:${validation.errors.join(",")}`);
  if (existsSync(fallbackCaddyJsonPath)) {
    writeArtifact(paths.caddyJsonPath, readFileSync(fallbackCaddyJsonPath, "utf8"));
  } else {
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
  }

  const validate = await composeConfigValidateForFileWithOverride(fallbackComposeFile);
  if (!validate.ok) throw new Error(`fallback_compose_validation_failed:${validate.stderr}`);

  const upAdmin = await composeActionForFileWithOverride("up", "admin", fallbackComposeFile);
  if (!upAdmin.ok) throw new Error(`fallback_compose_up_failed:admin:${upAdmin.stderr}`);

  const upCaddy = await composeActionForFileWithOverride("up", "caddy", fallbackComposeFile);
  if (!upCaddy.ok) throw new Error(`fallback_compose_up_failed:caddy:${upCaddy.stderr}`);
}

export async function selfTestFallbackBundle(manager: StackManager): Promise<{ ok: boolean; errors: string[] }> {
  const paths = manager.getPaths();
  const fallbackComposeFile = paths.fallbackComposeFilePath ?? "docker-compose-fallback.yml";
  const fallbackCaddyJsonPath = paths.fallbackCaddyJsonPath ?? join(paths.stateRootPath, "caddy-fallback.json");
  const validation = validateFallbackBundle({ composePath: fallbackComposeFile, caddyPath: fallbackCaddyJsonPath });
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const composeValidate = await composeConfigValidateForFileWithOverride(fallbackComposeFile);
  if (!composeValidate.ok) return { ok: false, errors: [composeValidate.stderr] };
  return { ok: true, errors: [] };
}

function enabledChannelServices(manager: StackManager): string[] {
  return manager.enabledChannelServiceNames();
}

async function deriveImpact(
  manager: StackManager,
  existing: ExistingArtifacts,
  generated: ReturnType<StackManager["renderPreview"]>,
  serviceCache: Map<string, Promise<string[]>>,
): Promise<StackImpact> {
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

  const impact = computeImpactFromChanges({
    ...changed,
    serviceConfigChanges: serviceConfigChanged,
  });
  if (existing.systemEnv !== generated.systemEnv) {
    impact.restart = Array.from(new Set([...impact.restart, "admin", "gateway"]));
  }
  if (existing.composeFile !== generated.composeFile) {
    const existingKey = manager.getPaths().composeFilePath;
    const generatedKey = `${manager.getPaths().composeFilePath}.next`;
    const existingPromise = serviceCache.get(existingKey) ?? composeConfigServicesWithOverride(existingKey);
    serviceCache.set(existingKey, existingPromise);
    const generatedPromise = serviceCache.get(generatedKey) ?? composeConfigServicesWithOverride(generatedKey);
    serviceCache.set(generatedKey, generatedPromise);
    const existingServices = await existingPromise;
    const generatedServices = await generatedPromise;

    const diff = diffServiceSets(existingServices, generatedServices);
    impact.up.push(...diff.added);
    impact.down.push(...diff.removed);
    impact.fullStack = diff.added.length > 0 || diff.removed.length > 0;

    if (!impact.fullStack) {
      impact.restart = Array.from(new Set([...impact.restart, "gateway", "assistant", "openmemory", "admin"]));
    }
  }

  const upSet = new Set(impact.up);
  impact.restart = impact.restart.filter((svc) => !upSet.has(svc));

  return impact;
}

export async function applyStack(manager: StackManager, options?: { apply?: boolean; rolloutMode?: RolloutMode }): Promise<StackApplyResult> {
  const generated = manager.renderPreview();
  const existing = readExistingArtifacts(manager);
  const transactionId = randomUUID();
  const secretErrors = manager.validateReferencedSecrets();
  if (secretErrors.length > 0) {
    throw new Error(`secret_validation_failed:${secretErrors.join(",")}`);
  }

  const warnings: string[] = [];
  const applyLockPath = manager.getPaths().applyLockPath ?? join(manager.getPaths().stateRootPath, "apply.lock");
  const preflightWarnings: string[] = [];
  if (options?.apply ?? true) {
    acquireApplyLock(applyLockPath, 10 * 60_000);
  }

  const serviceCache = new Map<string, Promise<string[]>>();
  const impact = await deriveImpact(manager, existing, generated, serviceCache);

  if (options?.apply ?? true) {
    const driftSpec = manager.computeDriftReport();
    const drift = await computeDriftReport(driftSpec);
    if (drift.missingServices.length > 0 || drift.exitedServices.length > 0 || drift.staleArtifacts) {
      warnings.push("drift_detected_before_apply");
    }
    const preflight = await runApplyPreflight({
      composeContent: generated.composeFile,
      paths: manager.getPaths(),
      socketUri: process.env.OPENPALM_CONTAINER_SOCKET_URI ?? "unix:///var/run/docker.sock",
      composeBin: process.env.OPENPALM_COMPOSE_BIN ?? "docker",
      pullServices: impact.up,
    });
    if (preflight.failures.length > 0) {
      const detail = preflight.failures.map((f) => `${f.check}:${f.message}`).join(",");
      throw new Error(`preflight_failed:${detail}`);
    }
    preflightWarnings.push(...preflight.warnings);
  }

  if (options?.apply ?? true) {
    try {
      const staged = manager.renderArtifactsToTemp(generated, { transactionId });
      const composeValidate = await composeConfigValidateForFileWithOverride(staged.composeFilePath);
      if (!composeValidate.ok) {
        staged.cleanup();
        throw new Error(`compose_validation_failed:${composeValidate.stderr}`);
      }
      staged.promote();

      const foundationalServices = new Set(["postgres", "qdrant", "openmemory", "assistant", "gateway"]);
      const firstPhase = impact.up.filter((service) => foundationalServices.has(service));
      const secondPhase = impact.up.filter((service) => !foundationalServices.has(service));
      const rolloutMode = options?.rolloutMode ?? "fast";
      const composePath = manager.getPaths().composeFilePath;
      if (impact.fullStack) {
        const result = await composeActionWithOverride("up", []);
        if (!result.ok) throw new Error(`compose_up_failed:full_stack:${result.stderr}`);
      } else {
        for (const service of [...firstPhase, ...secondPhase]) {
          const result = await composeActionWithOverride("up", service);
          if (!result.ok) throw new Error(`compose_up_failed:${service}:${result.stderr}`);
          if (rolloutMode === "safe") {
            const config = resolveServiceHealthConfig(composePath, service);
            const gate = await pollUntilHealthy(config);
            if (!gate.ok) throw new Error(`compose_health_gate_failed:${service}:${gate.error ?? "unknown"}`);
          }
        }
      }
      for (const service of impact.restart) {
        const result = await composeActionWithOverride("restart", service);
        if (!result.ok) throw new Error(`compose_restart_failed:${service}:${result.stderr}`);
        if (rolloutMode === "safe") {
          const config = resolveServiceHealthConfig(composePath, service);
          const gate = await pollUntilHealthy(config);
          if (!gate.ok) throw new Error(`compose_health_gate_failed:${service}:${gate.error ?? "unknown"}`);
        }
      }
      for (const service of impact.reload) {
        if (service === "caddy") {
          const result = await composeExecWithOverride("caddy", ["caddy", "reload", "--config", "/etc/caddy/caddy.json"]);
          if (!result.ok) throw new Error(`compose_reload_failed:${service}:${result.stderr}`);
          if (rolloutMode === "safe") {
            const config = resolveServiceHealthConfig(composePath, service);
            const gate = await pollUntilHealthy(config);
            if (!gate.ok) throw new Error(`compose_health_gate_failed:${service}:${gate.error ?? "unknown"}`);
          }
          continue;
        }
        const result = await composeActionWithOverride("restart", service);
        if (!result.ok) throw new Error(`compose_reload_failed:${service}:${result.stderr}`);
        if (rolloutMode === "safe") {
          const config = resolveServiceHealthConfig(composePath, service);
          const gate = await pollUntilHealthy(config);
          if (!gate.ok) throw new Error(`compose_health_gate_failed:${service}:${gate.error ?? "unknown"}`);
        }
      }

      for (const service of impact.down) {
        const stopResult = await composeActionWithOverride("stop", service);
        if (!stopResult.ok) throw new Error(`compose_stop_failed:${service}:${stopResult.stderr}`);
        const removeResult = await composeExecWithOverride("", ["rm", "-f", service]);
        if (!removeResult.ok) throw new Error(`compose_rm_failed:${service}:${removeResult.stderr}`);
      }

      staged.cleanup();
      staged.cleanupBackups();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      warnings.push(`stack_apply_failed_attempting_rollback:${errorMessage}`);
      try {
        restoreArtifacts(manager, existing);
        restorePrevArtifacts(manager);
        const rollbackValidate = await composeConfigValidateForFileWithOverride(manager.getPaths().composeFilePath);
        if (!rollbackValidate.ok) throw new Error(`rollback_compose_validation_failed:${rollbackValidate.stderr}`);
        for (const service of CoreRecoveryServices) {
          const rollbackUp = await composeActionWithOverride("up", service);
          if (!rollbackUp.ok) throw new Error(`rollback_compose_up_failed:${service}:${rollbackUp.stderr}`);
        }
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        warnings.push(`rollback_failed_attempting_fallback:${rollbackMessage}`);
        await fallbackToAdminAndCaddy(manager);
      }
      throw new Error(errorMessage);
    } finally {
      releaseApplyLock(applyLockPath);
    }
  }

  if (options?.apply ?? true) {
    const selfTest = await selfTestFallbackBundle(manager);
    if (!selfTest.ok) warnings.push(`fallback_self_test_failed:${selfTest.errors.join(",")}`);
  }

  return { ok: true, generated, impact, warnings, preflightWarnings };
}

function acquireApplyLock(lockPath: string, timeoutMs: number): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const content = readFileSync(lockPath, "utf8");
    const parsed = parseLockContent(content);
    if (parsed && Date.now() - parsed.timestamp < timeoutMs) {
      throw new Error("apply_lock_held");
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + "\n", "utf8");
}

function releaseApplyLock(lockPath: string): void {
  if (existsSync(lockPath)) rmSync(lockPath, { force: true });
}

function parseLockContent(content: string): { pid: number; timestamp: number } | null {
  try {
    const parsed = JSON.parse(content) as { pid: number; timestamp: number };
    if (typeof parsed.pid !== "number" || typeof parsed.timestamp !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function restorePrevArtifacts(manager: StackManager): void {
  const paths = manager.getPaths();
  const targets = [
    paths.caddyJsonPath,
    paths.composeFilePath,
    paths.systemEnvPath,
    paths.gatewayEnvPath,
    paths.openmemoryEnvPath,
    paths.postgresEnvPath,
    paths.qdrantEnvPath,
    paths.assistantEnvPath,
  ];
  for (const target of targets) {
    const prevPath = `${target}.prev`;
    if (existsSync(prevPath)) renameSync(prevPath, target);
  }
}
