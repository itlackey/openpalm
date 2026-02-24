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

export interface ComposeRunner {
  action(action: "up" | "stop" | "restart", service: string | string[]): Promise<ComposeResult>;
  exec(service: string, args: string[]): Promise<ComposeResult>;
  list(): Promise<ComposeResult>;
  ps(): Promise<{ ok: boolean; services: ServiceHealthState[]; stderr: string }>;
  configServices(composeFileOverride?: string): Promise<string[]>;
  configValidate(): Promise<ComposeResult>;
  configValidateForFile(composeFile: string, envFile?: string): Promise<ComposeResult>;
  pull(service?: string): Promise<ComposeResult>;
  logs(service: string, tail?: number): Promise<ComposeResult>;
  stackDown(): Promise<ComposeResult>;
}

export function createComposeRunner(): ComposeRunner {
  return {
    action: composeAction,
    exec: composeExec,
    list: composeList,
    ps: composePs,
    configServices: composeConfigServices,
    configValidate: composeConfigValidate,
    configValidateForFile: composeConfigValidateForFile,
    pull: composePull,
    logs: composeLogs,
    stackDown: composeStackDown,
  };
}

export function createMockRunner(overrides?: Partial<ComposeRunner>): ComposeRunner {
  const ok: ComposeResult = { ok: true, stdout: "", stderr: "" };
  return {
    action: async () => ok,
    exec: async () => ok,
    list: async () => ({ ...ok, stdout: "[]" }),
    ps: async () => ({ ok: true, services: [], stderr: "" }),
    configServices: async () => [],
    configValidate: async () => ok,
    configValidateForFile: async () => ok,
    pull: async () => ok,
    logs: async () => ok,
    stackDown: async () => ok,
    ...overrides,
  };
}

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

export async function composeConfigServices(composeFileOverride?: string): Promise<string[]> {
  const composeFile = composeFileOverride ?? composeFilePath();
  const result = await runCompose(["config", "--services"], composeFile, composeEnvFilePath());
  if (!result.ok) throw new Error(result.stderr || "compose_config_services_failed");
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

export async function allowedServiceSet(runner?: ComposeRunner): Promise<Set<string>> {
  const r = runner ?? createComposeRunner();
  const fromCompose = await r.configServices();
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


