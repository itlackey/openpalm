import { json } from "@sveltejs/kit";
import { checkDocker, checkDockerCompose, detectGpu, detectLocalProviders, detectRuntime, resolveHostUiPort, STACK_DEFAULTS } from "@openpalm/lib";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import type { RequestHandler } from "./$types";

/**
 * Returns true when the named port is published by an openpalm-managed
 * docker container — i.e. it's "in use" but the wizard's install will
 * either recreate or no-op on the same container, so flagging it as a
 * conflict is a false positive. Returns `unreachable` when Docker itself
 * cannot be queried, so the caller can degrade this from blocking to warning.
 */
async function portHeldByOurContainer(port: number): Promise<"held" | "free" | "unreachable"> {
  return new Promise((resolve) => {
    const run = (attempt: number) => {
      execFile(
        "docker",
        ["ps", "--format", "{{.Names}}\t{{.Ports}}"],
        { timeout: 5_000 },
        (err, stdout) => {
          if (err) {
            if (attempt === 0) return run(1);
            return resolve("unreachable");
          }
          const lines = stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            const [name, ports] = line.split("\t");
            if (!name?.startsWith("openpalm-")) continue;
            if (ports?.includes(`:${port}->`)) {
              return resolve("held");
            }
          }
          resolve("free");
        },
      );
    };

    run(0);
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
// portals reach it via Docker DNS (http://guardian:8080) and the host
// admin-tools health-check uses `docker container inspect` instead of HTTP.
//
// The host admin UI, container-served UI, and OpenCode listener are distinct
// required ports. Each reads its canonical env name and falls back to the stock
// default when unset.
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
    { port: pickPort("OP_HOST_UI_PORT")  ?? STACK_DEFAULTS.ports.hostUi, service: "admin", blocking: true },
    { port: pickPort("OP_UI_PORT")       ?? STACK_DEFAULTS.ports.ui, service: "ui", blocking: true },
    { port: pickPort("OP_ASSISTANT_PORT") ?? STACK_DEFAULTS.ports.assistant, service: "assistant", blocking: true },
  ];
}

// The SvelteKit adapter-node server listens on PORT. Trying to bind another
// TCP server on this same port always fails — suppress the false conflict.
const SERVER_PORT = Number(process.env.PORT) || resolveHostUiPort(undefined, process.env);

export const GET: RequestHandler = async () => {
  const [docker, compose, gpu, localProviders, runtime] = await Promise.all([
    checkDocker(),
    checkDockerCompose(),
    detectGpu(),
    detectLocalProviders(),
    detectRuntime(),
  ]);

  const targets = resolvePortsToCheck();
  let portCheckReliable = docker.ok;
  const ports = await Promise.all(
    targets.map(async (t) => {
      // Port is held by this process — not a conflict.
      if (t.port === SERVER_PORT) return { ...t, available: true };
      if (await checkPortAvailable(t.port)) return { ...t, available: true };

      const held = await portHeldByOurContainer(t.port);
      if (held === "held") return { ...t, available: true };
      if (held === "unreachable") {
        portCheckReliable = false;
        return { ...t, available: false, blocking: false };
      }

      return { ...t, available: false, blocking: portCheckReliable ? t.blocking : false };
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
    portCheckReliable,
    ports,
    platform: process.platform,
    runtime,
    // Back-compat: `gpu` is the display name string (SystemCheckStep reads it).
    // `gpuInfo` carries the full VRAM-aware detection.
    gpu: gpu?.name ?? undefined,
    gpuInfo: gpu ?? undefined,
    hostProviders: localProviders
      .filter((p) => p.available)
      .map(({ provider, url }) => ({ provider, url })),
  });
};

export const POST = GET;
