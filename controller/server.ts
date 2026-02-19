import { spawn } from "node:child_process";

const PORT = Number(Bun.env.PORT ?? 8090);
const TOKEN = Bun.env.CONTROLLER_TOKEN ?? "change-me-controller";
const PROJECT_PATH = Bun.env.COMPOSE_PROJECT_PATH ?? "/workspace";
const RUNTIME_PLATFORM = Bun.env.OPENPALM_CONTAINER_PLATFORM ?? "docker";
const COMPOSE_BIN = Bun.env.OPENPALM_COMPOSE_BIN ?? "docker";
const COMPOSE_SUBCOMMAND = Bun.env.OPENPALM_COMPOSE_SUBCOMMAND ?? "compose";
const COMPOSE_FILE = "docker-compose.yml";
const CONTAINER_SOCKET_URI = Bun.env.OPENPALM_CONTAINER_SOCKET_URI ?? "unix:///var/run/openpalm-container.sock";
const COMPOSE_COMMAND_DISPLAY = [COMPOSE_BIN, COMPOSE_SUBCOMMAND].filter(Boolean).join(" ");

export const ALLOWED = new Set(["opencode-core", "gateway", "openmemory", "admin", "channel-chat", "channel-discord", "channel-voice", "channel-telegram", "caddy"]);

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { "content-type": "application/json" } });
}

export type ComposeRunner = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const runCompose: ComposeRunner = (args: string[]) => {
  return new Promise((resolve) => {
    const composeArgs = COMPOSE_SUBCOMMAND
      ? [COMPOSE_SUBCOMMAND, "-f", COMPOSE_FILE, ...args]
      : ["-f", COMPOSE_FILE, ...args];
    const proc = spawn(COMPOSE_BIN, composeArgs, {
      cwd: PROJECT_PATH,
      env: {
        ...process.env,
        DOCKER_HOST: CONTAINER_SOCKET_URI,
        CONTAINER_HOST: CONTAINER_SOCKET_URI
      }
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (spawnError) => {
      err += spawnError.message;
      resolve({ ok: false, stdout: out, stderr: err });
    });
    proc.on("close", (code) => resolve({ ok: code === 0, stdout: out, stderr: err }));
  });
};

export function createControllerFetch(controllerToken: string, compose: ComposeRunner) {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return json(200, { ok: true, service: "controller" });
    if (req.headers.get("x-controller-token") !== controllerToken) return json(401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/containers") {
      const result = await compose(["ps", "--format", "json"]);
      if (!result.ok) return json(500, { ok: false, error: result.stderr });
      return json(200, { ok: true, containers: result.stdout });
    }

    if (req.method === "POST" && url.pathname.startsWith("/restart/")) {
      const service = url.pathname.replace("/restart/", "");
      if (!ALLOWED.has(service)) return json(400, { error: "service not allowed" });
      const result = await compose(["restart", service]);
      if (!result.ok) return json(500, { ok: false, error: result.stderr });
      return json(200, { ok: true, action: "restart", service, stdout: result.stdout });
    }

    if (req.method === "POST" && url.pathname.startsWith("/up/")) {
      const service = url.pathname.replace("/up/", "");
      if (!ALLOWED.has(service)) return json(400, { error: "service not allowed" });
      const result = await compose(["up", "-d", service]);
      if (!result.ok) return json(500, { ok: false, error: result.stderr });
      return json(200, { ok: true, action: "up", service, stdout: result.stdout });
    }

    if (req.method === "POST" && url.pathname.startsWith("/down/")) {
      const service = url.pathname.replace("/down/", "");
      if (!ALLOWED.has(service)) return json(400, { error: "service not allowed" });
      const result = await compose(["stop", service]);
      if (!result.ok) return json(500, { ok: false, error: result.stderr });
      return json(200, { ok: true, action: "down", service, stdout: result.stdout });
    }

    return json(404, { error: "not found" });
  };
}

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    fetch: createControllerFetch(TOKEN, runCompose)
  });

  console.log(`controller listening on ${PORT} (runtime=${RUNTIME_PLATFORM}, compose='${COMPOSE_COMMAND_DISPLAY}')`);
}
