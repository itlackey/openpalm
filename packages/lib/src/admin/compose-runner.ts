import { runCompose as runComposeShared } from "../compose-runner.ts";
import type { SpawnFn } from "../types.ts";

export const CoreServices = [
  "assistant", "gateway", "openmemory", "admin",
  "caddy", "openmemory-ui", "postgres", "qdrant"
] as const;
const UiManagedServiceExclusions = ["admin", "caddy"] as const;

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

type RunFn = (args: string[], composeFileOverride?: string, stream?: boolean) => Promise<ComposeResult>;

export function createComposeRunner(envFile?: string, spawn?: SpawnFn): ComposeRunner {
  const resolvedEnvFile = envFile ?? `${composeProjectPath()}/.env`;
  const run: RunFn = (args, composeFileOverride, stream) =>
    execCompose(args, composeFileOverride, resolvedEnvFile, stream, spawn);

  return {
    action: (action, service) => runAction(run, action, service),
    exec: (service, args) => runExec(run, service, args),
    list: () => run(["ps", "--format", "json"]),
    ps: () => runPs(run),
    configServices: (composeFileOverride) => runConfigServices(run, composeFileOverride),
    configValidate: () => run(["config"]),
    configValidateForFile: (composeFile, envFileOverride) =>
      execCompose(["config"], composeFile, envFileOverride ?? resolvedEnvFile, undefined, spawn),
    pull: (service) => runPull(run, service),
    logs: (service, tail) => runLogs(run, service, tail),
    stackDown: () => run(["down", "--remove-orphans"], undefined, true),
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

async function execCompose(args: string[], composeFileOverride?: string, envFile?: string, stream?: boolean, spawn?: SpawnFn): Promise<ComposeResult> {
  const composeFile = composeFileOverride ?? composeFilePath();
  const result = await runComposeShared(args, {
    bin: composeBin(),
    subcommand: composeSubcommand(),
    composeFile,
    envFile,
    cwd: composeProjectPath(),
    env: {
      DOCKER_HOST: containerSocketUri(),
      CONTAINER_HOST: containerSocketUri(),
    },
    stream,
    spawn,
  });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    code: result.code,
  };
}

async function ensureAllowedServices(run: RunFn, services: string[]): Promise<string | null> {
  const result = await run(["config", "--services"]);
  const fromCompose = result.ok
    ? result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    : [];
  const allowed = new Set<string>([...CoreServices, ...extraServicesFromEnv(), ...fromCompose]);
  for (const service of services) {
    if (!allowed.has(service)) return service;
  }
  return null;
}

type ServiceHealthState = {
  name: string;
  status: string;
  health?: string | null;
};

async function runPs(run: RunFn): Promise<{ ok: boolean; services: ServiceHealthState[]; stderr: string }> {
  const result = await run(["ps", "--format", "json"]);
  if (!result.ok) return { ok: false, services: [], stderr: result.stderr };
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) return { ok: true, services: [], stderr: "" };
  try {
    const raw = JSON.parse(trimmed) as Array<Record<string, unknown>>;
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

async function runPull(run: RunFn, service?: string): Promise<ComposeResult> {
  if (service) {
    const invalid = await ensureAllowedServices(run, [service]);
    if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
    return run(["pull", service], undefined, true);
  }
  return run(["pull"], undefined, true);
}

async function runLogs(run: RunFn, service: string, tail: number = 200): Promise<ComposeResult> {
  const invalid = await ensureAllowedServices(run, [service]);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  if (!composeLogsValidateTail(tail)) return { ok: false, stdout: "", stderr: "invalid_tail" };
  return run(["logs", service, "--tail", String(tail)]);
}

async function runAction(run: RunFn, action: "up" | "stop" | "restart", service: string | string[]): Promise<ComposeResult> {
  const services = Array.isArray(service) ? service : [service];
  if (services.length === 0) {
    if (action === "up") return run(["up", "-d", "--remove-orphans"], undefined, true);
    return { ok: false, stdout: "", stderr: "service_not_allowed" };
  }
  const invalid = await ensureAllowedServices(run, services);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  const cmd = action === "up" ? ["up", "-d", ...services] : [action, ...services];
  return run(cmd, undefined, true);
}

async function runConfigServices(run: RunFn, composeFileOverride?: string): Promise<string[]> {
  const result = await run(["config", "--services"], composeFileOverride);
  if (!result.ok) throw new Error(result.stderr || "compose_config_services_failed");
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

async function runExec(run: RunFn, service: string, args: string[]): Promise<ComposeResult> {
  if (!service) {
    return run(args, undefined, false);
  }
  const invalid = await ensureAllowedServices(run, [service]);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  return run(["exec", "-T", service, ...args], undefined, true);
}

let defaultRunner: ComposeRunner | undefined;
function getRunner(): ComposeRunner { return defaultRunner ??= createComposeRunner(); }

export async function allowedServiceSet(runner?: ComposeRunner): Promise<Set<string>> {
  const r = runner ?? getRunner();
  const fromCompose = await r.configServices();
  return new Set<string>([...CoreServices, ...extraServicesFromEnv(), ...fromCompose]);
}

export function composeList(): Promise<ComposeResult> { return getRunner().list(); }
export function composePull(service?: string): Promise<ComposeResult> { return getRunner().pull(service); }
export function composeLogs(service: string, tail?: number): Promise<ComposeResult> { return getRunner().logs(service, tail); }
export function composeAction(action: "up" | "stop" | "restart", service: string | string[]): Promise<ComposeResult> { return getRunner().action(action, service); }
export function composeExec(service: string, args: string[]): Promise<ComposeResult> { return getRunner().exec(service, args); }

export function composeLogsValidateTail(tail: number): boolean {
  return Number.isInteger(tail) && tail >= 1 && tail <= 5000;
}

export function filterUiManagedServices(services: string[]): string[] {
  const excluded = new Set<string>(UiManagedServiceExclusions);
  return services.filter((service) => !excluded.has(service));
}
