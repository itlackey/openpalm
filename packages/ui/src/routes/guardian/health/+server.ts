import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { guardianRequired, readStackEnv, resolveComposeProjectName } from "@openpalm/lib";
import { getRequestId, jsonResponse } from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import type { RequestHandler } from "./$types";

const execFileAsync = promisify(execFile);

async function findGuardianContainerId(projectName: string): Promise<string | null> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--filter",
      "label=com.docker.compose.service=guardian",
      "--format",
      "{{.ID}}",
    ],
    { timeout: 5000 },
  );
  return stdout.trim().split("\n").find(Boolean) ?? null;
}

/**
 * Guardian health — queries the running container directly.
 *
 * Guardian has no host port mapping in the 0.11.0+ layout (it's reachable
 * only on the internal portal_net/assistant_net networks). The previous
 * implementation read the UI's in-memory ControlPlaneState, which is stale
 * whenever the stack was started by something other than the UI itself
 * (CLI, docker compose directly, AppImage on a pre-existing stack).
 *
 * `docker container inspect ... --format '{{.State.Health.Status}}'` is the
 * authoritative source: it reads the compose-defined healthcheck the
 * guardian container already runs internally. Same approach as the
 * admin-tools-plugin host-side health-check tool.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);

  // With no reason for the guardian to exist (guardianRequired: no ingress
  // addon, no guardian access toggle, no remote tunnel targeting it), it is
  // intentionally not in the stack — report that cleanly (200) instead of
  // letting a `docker inspect` miss 503-spam the console. The previous
  // hardcoded addon list here omitted `gateway`, so a gateway-only install
  // reported the guardian as not deployed while it was running.
  try {
    if (!guardianRequired(getState().homeDir)) {
      return jsonResponse(200, { status: "not_deployed", service: "guardian" }, requestId);
    }
  } catch {
    // Fall through to the container probe on any state-read error.
  }

  try {
    const projectName = resolveComposeProjectName(readStackEnv(getState().homeDir));
    const containerId = await findGuardianContainerId(projectName);
    if (!containerId) {
      return jsonResponse(503, { status: "unreachable", service: "guardian" }, requestId);
    }
    const { stdout } = await execFileAsync(
      "docker",
      [
        "container",
        "inspect",
        containerId,
        "--format",
        "{{.State.Health.Status}}",
      ],
      { timeout: 5000 },
    );
    const status = stdout.trim();
    if (status === "healthy") {
      return jsonResponse(200, { status: "ok", service: "guardian" }, requestId);
    }
    return jsonResponse(
      503,
      { status: status || "unknown", service: "guardian" },
      requestId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      503,
      { status: "unreachable", service: "guardian", error: message },
      requestId,
    );
  }
};
