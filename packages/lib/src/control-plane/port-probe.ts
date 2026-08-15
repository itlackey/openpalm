/**
 * TCP port probing for the CLI `doctor` command (C2).
 *
 * Ported from the SvelteKit `api/setup/system-check` route (which only
 * renders once the UI is already up — no help when Docker or the UI port
 * itself is the problem) so `openpalm doctor` can run the same check
 * standalone.
 *
 * Audit refinement (C2): a plain TCP-bind probe run WHILE the stack is up
 * flags all three install ports as conflicts — a false positive for exactly
 * the operator whose stack is running. {@link portHeldByOurContainer} folds
 * in docker ownership so a port already published by this exact Compose
 * project is reported as "ours", not a conflict.
 */
import { createServer } from "node:net";
import { STACK_DEFAULTS } from "./defaults.js";
import type { DockerClient } from "./docker.js";
import { realDockerClient } from "./docker.js";

export type PortOwnership = "held" | "free" | "unreachable";

/** Check whether a TCP port is bindable on 127.0.0.1. */
export async function checkPortAvailable(port: number, timeoutMs = 1000): Promise<boolean> {
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
    srv.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    srv.once("listening", () => {
      clearTimeout(timer);
      finish(true);
    });
    srv.listen(port, "127.0.0.1");
  });
}

function publishesIpv4LoopbackTcpPort(renderedPorts: string, port: number): boolean {
  for (const renderedPort of renderedPorts.split(",")) {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp$/.exec(
      renderedPort.trim(),
    );
    if (!match) continue;

    const address = match[1].split(".").map(Number);
    const isLoopback = address[0] === 127;
    const isWildcard = address.every((octet) => octet === 0);
    if ((!isLoopback && !isWildcard) || address.some((octet) => octet > 255)) continue;

    const firstPort = Number(match[2]);
    const lastPort = Number(match[3] ?? match[2]);
    if (port >= firstPort && port <= lastPort) return true;
  }
  return false;
}

/**
 * Is the named port published over IPv4 loopback by this exact Compose
 * project? Returns "unreachable" when Docker itself cannot be queried.
 */
export async function portHeldByOurContainer(
  port: number,
  composeProject: { name: string; workingDir: string },
  client: DockerClient = realDockerClient,
): Promise<PortOwnership> {
  const result = await client.run([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${composeProject.name}`,
    "--format",
    '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Ports}}',
  ]);
  if (!result.ok) return "unreachable";
  for (const line of result.stdout.split(/\r?\n/)) {
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const workingDir = line.slice(0, separator);
    const ports = line.slice(separator + 1);
    if (
      workingDir === composeProject.workingDir &&
      publishesIpv4LoopbackTcpPort(ports, port)
    ) {
      return "held";
    }
  }
  return "free";
}

export interface InstallPortTarget {
  port: number;
  service: string;
  blocking: boolean;
}

export interface InstallPortStatus extends InstallPortTarget {
  available: boolean;
  ownership?: PortOwnership | "ours";
}

function pickPort(...envNames: string[]): number | null {
  for (const name of envNames) {
    const raw = process.env[name];
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * The install ports doctor probes, sourced from the same env vars the
 * install will publish (mirrors `packages/cli/src/commands/install.ts` and
 * the system-check route's `resolvePortsToCheck`). Guardian is intentionally
 * absent — it has no host port mapping.
 */
export function resolveInstallPortTargets(): InstallPortTarget[] {
  return [
    { port: pickPort("OP_HOST_UI_PORT") ?? STACK_DEFAULTS.ports.hostUi, service: "admin", blocking: true },
    { port: pickPort("OP_UI_PORT") ?? STACK_DEFAULTS.ports.ui, service: "ui", blocking: true },
    { port: pickPort("OP_ASSISTANT_PORT") ?? STACK_DEFAULTS.ports.assistant, service: "assistant", blocking: true },
    // Non-blocking: a taken workspace port costs /advanced its embedded
    // OpenCode UI, which falls back to the native chat surface. Nothing else
    // in the stack depends on it, so it is not worth refusing an install over.
    { port: pickPort("OP_WORKSPACE_PORT") ?? STACK_DEFAULTS.ports.workspace, service: "workspace", blocking: false },
  ];
}

export interface ProbeInstallPortsOptions {
  client?: DockerClient;
  /** Whether Docker itself is reachable — pass the already-computed `checkDocker()` result so this doesn't re-probe it per port. Defaults to true (assume reachable). */
  dockerAvailable?: boolean;
  /** A port this very process is already listening on (e.g. the admin UI's own server) — never a conflict. */
  serverPort?: number;
  /** Compose identity required to attribute each occupied port to this exact installed project. */
  composeProject?: { name: string; workingDir: string };
}

/**
 * Probe each install port for availability, folding in container ownership
 * so a port held by OUR OWN running stack reads as available, not a
 * conflict (C2 audit refinement).
 */
export async function probeInstallPorts(
  targets: InstallPortTarget[] = resolveInstallPortTargets(),
  opts: ProbeInstallPortsOptions = {},
): Promise<InstallPortStatus[]> {
  const client = opts.client ?? realDockerClient;
  const dockerAvailable = opts.dockerAvailable ?? true;

  return Promise.all(
    targets.map(async (t): Promise<InstallPortStatus> => {
      if (opts.serverPort !== undefined && t.port === opts.serverPort) {
        return { ...t, available: true, ownership: "ours" };
      }
      if (await checkPortAvailable(t.port)) {
        return { ...t, available: true };
      }
      if (!dockerAvailable) {
        return { ...t, available: false, blocking: false, ownership: "unreachable" };
      }
      const ownership = opts.composeProject
        ? await portHeldByOurContainer(t.port, opts.composeProject, client)
        : "free";
      if (ownership === "held") {
        return { ...t, available: true, ownership };
      }
      if (ownership === "unreachable") {
        return { ...t, available: false, blocking: false, ownership };
      }
      return { ...t, available: false, ownership, blocking: t.blocking };
    }),
  );
}
