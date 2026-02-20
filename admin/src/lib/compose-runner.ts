import { spawn } from "node:child_process";

const CoreServices = [
  "opencode-core", "gateway", "openmemory", "admin",
  "channel-chat", "channel-discord", "channel-voice",
  "channel-telegram", "caddy", "openmemory-ui", "postgres", "qdrant"
] as const;

const extraServices = (Bun.env.OPENPALM_EXTRA_SERVICES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

export const AllowedServices = new Set<string>([...CoreServices, ...extraServices]);

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

export async function composeList(): Promise<ComposeResult> {
  return runCompose(["ps", "--format", "json"]);
}

export async function composeAction(action: "up" | "down" | "restart", service: string): Promise<ComposeResult> {
  if (!AllowedServices.has(service)) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  if (action === "up") return runCompose(["up", "-d", service]);
  if (action === "down") return runCompose(["stop", service]);
  return runCompose(["restart", service]);
}
