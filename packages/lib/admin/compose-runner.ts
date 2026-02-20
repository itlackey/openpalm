import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const CoreServices = [
  "opencode-core", "gateway", "openmemory", "admin",
  "channel-chat", "channel-discord", "channel-voice",
  "channel-telegram", "caddy", "openmemory-ui", "postgres", "qdrant"
] as const;

const extraServices = (Bun.env.OPENPALM_EXTRA_SERVICES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

const ComposeProjectPath = Bun.env.COMPOSE_PROJECT_PATH ?? "/workspace";
const ComposeBin = Bun.env.OPENPALM_COMPOSE_BIN ?? "docker";
const ComposeSubcommand = Bun.env.OPENPALM_COMPOSE_SUBCOMMAND ?? "compose";
const ComposeFile = Bun.env.OPENPALM_COMPOSE_FILE ?? "docker-compose.yml";
const ContainerSocketUri = Bun.env.OPENPALM_CONTAINER_SOCKET_URI ?? "unix:///var/run/docker.sock";

export type ComposeResult = { ok: boolean; stdout: string; stderr: string };

function runCompose(args: string[]): Promise<ComposeResult> {
  return new Promise((resolve) => {
    const composeArgs = ComposeSubcommand
      ? [ComposeSubcommand, "-f", ComposeFile, ...args]
      : ["-f", ComposeFile, ...args];
    const proc = spawn(ComposeBin, composeArgs, {
      cwd: ComposeProjectPath,
      env: {
        ...process.env,
        DOCKER_HOST: ContainerSocketUri,
        CONTAINER_HOST: ContainerSocketUri,
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      stderr += error.message;
      resolve({ ok: false, stdout, stderr });
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function parseServiceNamesFromComposeFile(): string[] {
  const path = `${ComposeProjectPath}/${ComposeFile}`;
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

export function allowedServiceSet(): Set<string> {
  const fromCompose = parseServiceNamesFromComposeFile();
  const declared = [...CoreServices, ...extraServices, ...fromCompose];
  return new Set<string>(declared);
}

function ensureAllowedServices(services: string[]): string | null {
  const allowed = allowedServiceSet();
  for (const service of services) {
    if (!allowed.has(service)) return service;
  }
  return null;
}

export async function composeConfigValidate(): Promise<ComposeResult> {
  return runCompose(["config"]);
}

export async function composeList(): Promise<ComposeResult> {
  return runCompose(["ps", "--format", "json"]);
}

export async function composePull(service?: string): Promise<ComposeResult> {
  if (service) {
    const invalid = ensureAllowedServices([service]);
    if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
    return runCompose(["pull", service]);
  }
  return runCompose(["pull"]);
}

export function composeLogsValidateTail(tail: number): boolean {
  return Number.isInteger(tail) && tail >= 1 && tail <= 5000;
}

export async function composeLogs(service: string, tail: number = 200): Promise<ComposeResult> {
  const invalid = ensureAllowedServices([service]);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  if (!composeLogsValidateTail(tail)) return { ok: false, stdout: "", stderr: "invalid_tail" };
  return runCompose(["logs", service, "--tail", String(tail)]);
}

export async function composeServiceNames(): Promise<string[]> {
  return Array.from(allowedServiceSet()).sort();
}

export async function composeAction(action: "up" | "down" | "restart", service: string | string[]): Promise<ComposeResult> {
  const services = Array.isArray(service) ? service : [service];
  const invalid = ensureAllowedServices(services);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  if (action === "up") return runCompose(["up", "-d", ...services]);
  if (action === "down") return runCompose(["stop", ...services]);
  return runCompose(["restart", ...services]);
}

export async function composeExec(service: string, args: string[]): Promise<ComposeResult> {
  const invalid = ensureAllowedServices([service]);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  return runCompose(["exec", "-T", service, ...args]);
}
