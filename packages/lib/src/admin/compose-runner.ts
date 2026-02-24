import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runCompose as runComposeShared } from "../compose-runner.ts";

export const CoreServices = [
  "assistant", "gateway", "openmemory", "admin",
  "caddy", "openmemory-ui", "postgres", "qdrant"
] as const;
export const UiManagedServiceExclusions = ["admin", "caddy"] as const;

type RuntimeEnv = Record<string, string | undefined>;

function envValue(name: string): string | undefined {
  const bunEnv = (globalThis as { Bun?: { env?: RuntimeEnv } }).Bun?.env;
  return bunEnv?.[name] ?? process.env[name];
}

function composeProjectPath(): string {
  return envValue("COMPOSE_PROJECT_PATH") ?? "/state";
}

function composeBin(): string {
  return envValue("OPENPALM_COMPOSE_BIN") ?? "docker";
}

function composeSubcommand(): string {
  return envValue("OPENPALM_COMPOSE_SUBCOMMAND") ?? "compose";
}

function composeFilePath(): string {
  return envValue("OPENPALM_COMPOSE_FILE") ?? "docker-compose.yml";
}

function composeEnvFilePath(): string | undefined {
  return envValue("OPENPALM_COMPOSE_ENV_FILE") ?? envValue("COMPOSE_ENV_FILE");
}

function containerSocketUri(): string {
  return envValue("OPENPALM_CONTAINER_SOCKET_URI") ?? "unix:///var/run/docker.sock";
}

function extraServicesFromEnv(): string[] {
  return (envValue("OPENPALM_EXTRA_SERVICES") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export type ComposeResult = { ok: boolean; stdout: string; stderr: string; exitCode?: number; code?: string };

async function runCompose(args: string[], composeFileOverride?: string, envFileOverride?: string, stream?: boolean): Promise<ComposeResult> {
  const composeFile = composeFileOverride ?? composeFilePath();
  const result = await runComposeShared(args, {
    bin: composeBin(),
    subcommand: composeSubcommand(),
    composeFile,
    envFile: envFileOverride,
    cwd: composeProjectPath(),
    env: {
      DOCKER_HOST: containerSocketUri(),
      CONTAINER_HOST: containerSocketUri(),
    },
    stream,
  });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    code: result.code,
  };
}

function parseServiceNamesFromComposeFile(): string[] {
  const path = `${composeProjectPath()}/${composeFilePath()}`;
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const lines = content.split(/\r?\n/);
  const names: string[] = [];
  let inServices = false;
  for (const line of lines) {
    if (!inServices) {
      if (line.trim() === "services:") inServices = true;
      continue;
    }
    if (/^[^\s#]/.test(line) && line.trim() !== "") break;
    const match = /^\s{2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

export async function composeConfigServices(composeFileOverride?: string): Promise<string[]> {
  const composeFile = composeFileOverride ?? composeFilePath();
  const result = await runCompose(["config", "--services"], composeFile, composeEnvFilePath());
  if (!result.ok) throw new Error(result.stderr || "compose_config_services_failed");
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

export type ComposeConfigServicesFn = typeof composeConfigServices;
let composeConfigServicesOverride: ComposeConfigServicesFn | null = null;

export function setComposeConfigServicesOverride(next: ComposeConfigServicesFn | null): void {
  composeConfigServicesOverride = next;
}

export async function composeConfigServicesWithOverride(composeFileOverride?: string): Promise<string[]> {
  if (composeConfigServicesOverride) return composeConfigServicesOverride(composeFileOverride);
  return composeConfigServices(composeFileOverride);
}

export async function allowedServiceSet(): Promise<Set<string>> {
  const fromCompose = await composeConfigServicesWithOverride();
  const declared = [...CoreServices, ...extraServicesFromEnv(), ...fromCompose];
  return new Set<string>(declared);
}

async function ensureAllowedServices(services: string[]): Promise<string | null> {
  const allowed = await allowedServiceSet();
  for (const service of services) {
    if (!allowed.has(service)) return service;
  }
  return null;
}

export async function composeConfigValidate(): Promise<ComposeResult> {
  return runCompose(["config"], undefined, composeEnvFilePath());
}

export async function composeConfigValidateForFile(composeFile: string, envFileOverride?: string): Promise<ComposeResult> {
  return runCompose(["config"], composeFile, envFileOverride ?? composeEnvFilePath());
}

export async function composeList(): Promise<ComposeResult> {
  return runCompose(["ps", "--format", "json"], undefined, composeEnvFilePath());
}

export type ComposeListFn = typeof composeList;
let composeListOverride: ComposeListFn | null = null;

export function setComposeListOverride(next: ComposeListFn | null): void {
  composeListOverride = next;
}

export async function composeListWithOverride(): Promise<ComposeResult> {
  if (composeListOverride) return composeListOverride();
  return composeList();
}

export type DriftReport = {
  missingServices: string[];
  exitedServices: string[];
  missingEnvFiles: string[];
  staleArtifacts: boolean;
};

export async function computeDriftReport(args: { expectedServices: string[]; envFiles: string[]; artifactHashes: { compose: string; caddy: string }; driftReportPath?: string }): Promise<DriftReport> {
  const missingServices: string[] = [];
  const exitedServices: string[] = [];
  const missingEnvFiles: string[] = [];
  const result = await composeListWithOverride();
  if (result.ok) {
    const running = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    const runningNames = new Set(running.map((item) => String(item.Service ?? item.Name ?? "")));
    for (const svc of args.expectedServices) {
      if (!runningNames.has(svc)) missingServices.push(svc);
    }
    for (const svc of running) {
      const state = String(svc.State ?? "");
      if (state && state !== "running") exitedServices.push(String(svc.Service ?? ""));
    }
  }
  for (const env of args.envFiles) {
    if (!existsSync(env)) missingEnvFiles.push(env);
  }
  let staleArtifacts = false;
  try {
    const composePath = composeArtifactOverrides.composeFilePath ?? composeFilePath();
    const caddyPath = composeArtifactOverrides.caddyJsonPath ?? envValue("OPENPALM_CADDY_JSON_PATH") ?? "/state/caddy.json";
    const compose = readFileSync(composePath, "utf8");
    const caddy = readFileSync(caddyPath, "utf8");
    const composeHash = createHash("sha256").update(compose).digest("hex");
    const caddyHash = createHash("sha256").update(caddy).digest("hex");
    const intendedComposeHash = createHash("sha256").update(args.artifactHashes.compose).digest("hex");
    const intendedCaddyHash = createHash("sha256").update(args.artifactHashes.caddy).digest("hex");
    staleArtifacts = composeHash != intendedComposeHash || caddyHash != intendedCaddyHash;
  } catch {
    staleArtifacts = true;
  }
  if (args.driftReportPath) {
    persistDriftReport({ missingServices, exitedServices, missingEnvFiles, staleArtifacts }, args.driftReportPath);
  } else {
    persistDriftReport({ missingServices, exitedServices, missingEnvFiles, staleArtifacts });
  }
  return { missingServices, exitedServices, missingEnvFiles, staleArtifacts };
}

export function persistDriftReport(report: DriftReport, reportPath?: string): void {
  const resolvedPath = reportPath
    ?? composeArtifactOverrides.driftReportPath
    ?? `${composeProjectPath()}/drift-report.json`;
  writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export type ServiceHealthState = {
  name: string;
  status: string;
  health?: string | null;
};

export async function composePs(): Promise<{ ok: boolean; services: ServiceHealthState[]; stderr: string }> {
  const result = await runCompose(["ps", "--format", "json"], undefined, composeEnvFilePath());
  if (!result.ok) return { ok: false, services: [], stderr: result.stderr };
  try {
    const raw = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    const services = raw.map((entry) => ({
      name: String(entry.Service ?? entry.Name ?? ""),
      status: String(entry.State ?? entry.Status ?? ""),
      health: entry.Health ? String(entry.Health) : null,
    })).filter((entry) => entry.name.length > 0);
    return { ok: true, services, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, services: [], stderr: `compose_ps_parse_failed:${message}` };
  }
}

export type ComposePsFn = typeof composePs;
let composePsOverride: ComposePsFn | null = null;

export function setComposePsOverride(next: ComposePsFn | null): void {
  composePsOverride = next;
}

export async function composePsWithOverride(): Promise<{ ok: boolean; services: ServiceHealthState[]; stderr: string }> {
  if (composePsOverride) return composePsOverride();
  return composePs();
}

export async function composePull(service?: string): Promise<ComposeResult> {
  if (service) {
    const invalid = await ensureAllowedServices([service]);
    if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
    return runCompose(["pull", service], undefined, composeEnvFilePath(), true);
  }
  return runCompose(["pull"], undefined, composeEnvFilePath(), true);
}

export function composeLogsValidateTail(tail: number): boolean {
  return Number.isInteger(tail) && tail >= 1 && tail <= 5000;
}

export async function composeLogs(service: string, tail: number = 200): Promise<ComposeResult> {
  const invalid = await ensureAllowedServices([service]);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  if (!composeLogsValidateTail(tail)) return { ok: false, stdout: "", stderr: "invalid_tail" };
  return runCompose(["logs", service, "--tail", String(tail)], undefined, composeEnvFilePath());
}

export async function composeServiceNames(): Promise<string[]> {
  return Array.from(await allowedServiceSet()).sort();
}

export function filterUiManagedServices(services: string[]): string[] {
  const excluded = new Set<string>(UiManagedServiceExclusions);
  return services.filter((service) => !excluded.has(service));
}

export async function composeAction(action: "up" | "stop" | "restart", service: string | string[]): Promise<ComposeResult> {
  const services = Array.isArray(service) ? service : [service];
  if (services.length === 0 && action !== "up") {
    return { ok: false, stdout: "", stderr: "service_not_allowed" };
  }
  if (services.length === 0 && action === "up") {
    return runCompose(["up", "-d", "--remove-orphans"], undefined, composeEnvFilePath(), true);
  }
  const invalid = await ensureAllowedServices(services);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  if (action === "up") return runCompose(["up", "-d", ...services], undefined, composeEnvFilePath(), true);
  if (action === "stop") return runCompose(["stop", ...services], undefined, composeEnvFilePath(), true);
  return runCompose(["restart", ...services], undefined, composeEnvFilePath(), true);
}

export async function composeActionForFile(action: "up" | "stop" | "restart", service: string | string[], composeFile: string, envFileOverride?: string): Promise<ComposeResult> {
  const services = Array.isArray(service) ? service : [service];
  if (action === "up") return runCompose(["up", "-d", ...services], composeFile, envFileOverride ?? composeEnvFilePath(), true);
  if (action === "stop") return runCompose(["stop", ...services], composeFile, envFileOverride ?? composeEnvFilePath(), true);
  return runCompose(["restart", ...services], composeFile, envFileOverride ?? composeEnvFilePath(), true);
}

export async function composeStackDown(): Promise<ComposeResult> {
  return runCompose(["down", "--remove-orphans"], undefined, composeEnvFilePath(), true);
}

export async function composeExec(service: string, args: string[]): Promise<ComposeResult> {
  if (!service) {
    return runCompose(args, undefined, composeEnvFilePath(), true);
  }
  const invalid = await ensureAllowedServices([service]);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  return runCompose(["exec", "-T", service, ...args], undefined, composeEnvFilePath(), true);
}

export type ComposeRunnerOverrides = {
  composeAction?: typeof composeAction;
  composeExec?: typeof composeExec;
  composeActionForFile?: typeof composeActionForFile;
  composeConfigValidateForFile?: typeof composeConfigValidateForFile;
  composeConfigValidate?: typeof composeConfigValidate;
};

let composeOverrides: ComposeRunnerOverrides = {};

export function setComposeRunnerOverrides(next: ComposeRunnerOverrides): void {
  composeOverrides = next;
}

export type ComposeRunnerArtifactOverrides = {
  composeFilePath?: string;
  caddyJsonPath?: string;
  driftReportPath?: string;
};

let composeArtifactOverrides: ComposeRunnerArtifactOverrides = {};

export function setComposeRunnerArtifactOverrides(next: ComposeRunnerArtifactOverrides): void {
  composeArtifactOverrides = next;
}

export async function composeActionWithOverride(action: "up" | "stop" | "restart", service: string | string[]): Promise<ComposeResult> {
  if (composeOverrides.composeAction) return composeOverrides.composeAction(action, service);
  return composeAction(action, service);
}

export async function composeExecWithOverride(service: string, args: string[]): Promise<ComposeResult> {
  if (composeOverrides.composeExec) return composeOverrides.composeExec(service, args);
  return composeExec(service, args);
}

export async function composeActionForFileWithOverride(
  action: "up" | "stop" | "restart",
  service: string | string[],
  composeFile: string,
  envFileOverride?: string,
): Promise<ComposeResult> {
  if (composeOverrides.composeActionForFile) return composeOverrides.composeActionForFile(action, service, composeFile, envFileOverride);
  return composeActionForFile(action, service, composeFile, envFileOverride);
}

export async function composeConfigValidateForFileWithOverride(composeFile: string, envFileOverride?: string): Promise<ComposeResult> {
  if (composeOverrides.composeConfigValidateForFile) return composeOverrides.composeConfigValidateForFile(composeFile, envFileOverride);
  return composeConfigValidateForFile(composeFile, envFileOverride);
}

export async function composeConfigValidateWithOverride(): Promise<ComposeResult> {
  if (composeOverrides.composeConfigValidate) return composeOverrides.composeConfigValidate();
  return composeConfigValidate();
}
