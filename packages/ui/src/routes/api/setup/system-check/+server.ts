import { json } from "@sveltejs/kit";
import { checkDocker, checkDockerCompose } from "@openpalm/lib";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import type { RequestHandler } from "./$types";

// Detect GPU via nvidia-smi — returns name if found, null otherwise.
function detectGpu(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      { timeout: 3_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const name = stdout?.toString().trim().split("\n")[0]?.trim();
        resolve(name || null);
      },
    );
  });
}

/**
 * Returns true when the named port is published by an openpalm-managed
 * docker container — i.e. it's "in use" but the wizard's install will
 * either recreate or no-op on the same container, so flagging it as a
 * conflict is a false positive. Best-effort: returns false on any
 * docker error.
 */
async function portHeldByOurContainer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["ps", "--format", "{{.Names}}\t{{.Ports}}"],
      { timeout: 5_000 },
      (err, stdout) => {
        if (err) return resolve(false);
        const lines = stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          const [name, ports] = line.split("\t");
          if (!name || !name.startsWith("openpalm-")) continue;
          if (ports && ports.includes(`:${port}->`)) {
            return resolve(true);
          }
        }
        resolve(false);
      },
    );
  });
}

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
//
// Guardian is intentionally NOT in this list: it has no host port mapping —
// channels reach it via Docker DNS (http://guardian:8080) and the host
// admin-tools health-check uses `docker container inspect` instead of HTTP.
//
// Env-name resolution honors BOTH the historic OP_ADMIN_PORT / OP_ASSISTANT_PORT
// (used by dev-setup.sh and existing dev installs) and the newer OP_HOST_*
// names. OP_HOST_* wins when present; falls back to the legacy name; falls back
// to the stock default. Avoids a false "port in use" on dev stacks whose
// stack.env predates the rename.
function pickPort(...envNames: string[]): number | null {
  for (const name of envNames) {
    const raw = process.env[name];
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function resolvePortsToCheck(): { port: number; service: string; blocking: boolean }[] {
  return [
    { port: pickPort("OP_HOST_UI_PORT", "OP_ADMIN_PORT")            ?? 3880, service: "admin",     blocking: true },
    { port: pickPort("OP_HOST_ASSISTANT_PORT", "OP_ASSISTANT_PORT") ?? 3800, service: "assistant", blocking: true },
  ];
}

// The SvelteKit adapter-node server listens on PORT. Trying to bind another
// TCP server on this same port always fails — suppress the false conflict.
const SERVER_PORT = Number(process.env.PORT ?? process.env.OP_HOST_UI_PORT ?? 3880);

export const GET: RequestHandler = async () => {
  const [docker, compose, gpu] = await Promise.all([checkDocker(), checkDockerCompose(), detectGpu()]);

  const targets = resolvePortsToCheck();
  const ports = await Promise.all(
    targets.map(async (t) => {
      // Port is held by this process — not a conflict.
      if (t.port === SERVER_PORT) return { ...t, available: true };
      if (await checkPortAvailable(t.port)) return { ...t, available: true };
      // Port is in use — but if it's one of our own containers, the
      // install will recreate it, not collide. Don't flag as blocking.
      if (await portHeldByOurContainer(t.port)) return { ...t, available: true };
      return { ...t, available: false };
    }),
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
    // portCheckReliable is false when Docker is unreachable — port checks
    // still run (TCP bind) but we can't confirm whether our own containers
    // hold them, so conflicts may be false positives.
    portCheckReliable: docker.ok,
    ports,
    platform: process.platform,
    gpu: gpu ?? undefined,
  });
};

export const POST = GET;
