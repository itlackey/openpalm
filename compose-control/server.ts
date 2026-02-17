import { spawn } from "node:child_process";

const PORT = Number(Bun.env.PORT ?? 8090);
const TOKEN = Bun.env.COMPOSE_CONTROL_TOKEN ?? "change-me-compose-control";
const PROJECT_PATH = Bun.env.COMPOSE_PROJECT_PATH ?? "/workspace";
const ALLOWED = new Set(["opencode", "gateway", "openmemory"]);

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { "content-type": "application/json" } });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return json(200, { ok: true });
    if (req.headers.get("x-compose-control-token") !== TOKEN) return json(401, { error: "unauthorized" });

    if (req.method === "POST" && url.pathname.startsWith("/restart/")) {
      const service = url.pathname.replace("/restart/", "");
      if (!ALLOWED.has(service)) return json(400, { error: "service not allowed" });

      const proc = spawn("docker", ["compose", "restart", service], { cwd: PROJECT_PATH });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => (out += d.toString()));
      proc.stderr.on("data", (d) => (err += d.toString()));

      await new Promise<void>((resolve) => proc.on("close", () => resolve()));
      if (err) return json(500, { ok: false, error: err });
      return json(200, { ok: true, stdout: out });
    }

    return json(404, { error: "not found" });
  }
});

console.log(`compose-control listening on ${PORT}`);
