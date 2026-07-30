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
 * in docker ownership so a port already held by an `openpalm-*` container is
 * reported as "ours", not a conflict.
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

/**
 * Is the named port published by an openpalm-managed container? Returns
 * "unreachable" when Docker itself cannot be queried (caller should degrade
 * a resulting conflict from blocking to warning, exactly like the UI route).
 */
export async function portHeldByOurContainer(
  port: number,
  client: DockerClient = realDockerClient,
): Promise<PortOwnership> {
  const result = await client.run(["ps", "--format", "{{.Names}}\t{{.Ports}}"]);
  if (!result.ok) return "unreachable";
  const lines = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const [name, ports] = line.split("\t");
    if (!name?.startsWith("openpalm-")) continue;
    if (ports?.includes(`:${port}->`)) return "held";
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
  ];
}

export interface ProbeInstallPortsOptions {
  client?: DockerClient;
  /** Whether Docker itself is reachable — pass the already-computed `checkDocker()` result so this doesn't re-probe it per port. Defaults to true (assume reachable). */
  dockerAvailable?: boolean;
  /** A port this very process is already listening on (e.g. the admin UI's own server) — never a conflict. */
  serverPort?: number;
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
      const ownership = await portHeldByOurContainer(t.port, client);
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
