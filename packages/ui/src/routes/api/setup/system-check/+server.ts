import { json } from "@sveltejs/kit";
import { checkDocker, checkDockerCompose } from "@openpalm/lib";
import { createServer } from "node:net";
import type { RequestHandler } from "./$types";

// Check whether a TCP port is bindable on 127.0.0.1. Used to flag conflicts
// with the assistant (3800), admin UI (3880), and guardian (8180) defaults.
async function checkPortAvailable(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      srv.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    srv.once("error", () => { clearTimeout(timer); finish(false); });
    srv.once("listening", () => { clearTimeout(timer); finish(true); });
    srv.listen(port, "127.0.0.1");
  });
}

const DEFAULT_PORTS = [3800, 3880, 8180];

export const GET: RequestHandler = async () => {
  const [docker, compose] = await Promise.all([checkDocker(), checkDockerCompose()]);

  const ports = await Promise.all(
    DEFAULT_PORTS.map(async (port) => ({ port, available: await checkPortAvailable(port) })),
  );

  return json({
    ok: true,
    docker: {
      ok: docker.ok,
      version: docker.stdout?.trim() || undefined,
      error: !docker.ok ? (docker.stderr?.trim() || "Docker is not available") : undefined,
    },
    compose: {
      ok: compose.ok,
      version: compose.stdout?.trim().split("\n")[0] || undefined,
      error: !compose.ok ? (compose.stderr?.trim() || "Docker Compose v2 not found") : undefined,
    },
    ports,
    platform: process.platform,
  });
};

export const POST = GET;
