import { json } from "@sveltejs/kit";
import { checkDocker, checkDockerCompose } from "@openpalm/lib";
import { createServer } from "node:net";
import type { RequestHandler } from "./$types";

// Check whether a TCP port is bindable on 127.0.0.1. Used to flag conflicts
// with the admin UI, assistant, and guardian ports the install will publish.
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

// Source the ports from the same env vars the install will publish. Defaults
// match packages/cli/src/commands/install.ts and dev-setup.sh.
// `blocking: true` means the install REQUIRES this port — if it's in use, the
// UI should disable Continue until the user frees it.
function resolvePortsToCheck(): { port: number; service: string; blocking: boolean }[] {
  return [
    { port: Number(process.env.OP_HOST_UI_PORT)        || 3880, service: "admin",     blocking: true },
    { port: Number(process.env.OP_HOST_ASSISTANT_PORT) || 3800, service: "assistant", blocking: true },
    { port: Number(process.env.OP_HOST_GUARDIAN_PORT)  || 8180, service: "guardian",  blocking: true },
  ];
}

export const GET: RequestHandler = async () => {
  const [docker, compose] = await Promise.all([checkDocker(), checkDockerCompose()]);

  const targets = resolvePortsToCheck();
  const ports = await Promise.all(
    targets.map(async (t) => ({
      port: t.port,
      service: t.service,
      blocking: t.blocking,
      available: await checkPortAvailable(t.port),
    })),
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
