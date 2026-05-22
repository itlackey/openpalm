/**
 * In-process deploy state for the setup wizard.
 *
 * Tracks Docker Compose deploy progress during first-time setup.
 * State lives in this module so the polling endpoint can read it
 * without a database or filesystem dependency.
 */
import {
  applyInstall,
  buildComposeOptions,
  buildManagedServices,
  composePull,
  composeUp,
  createLogger,
  isSetupComplete,
  resolveStackDir,
} from "@openpalm/lib";
import type { ControlPlaneState } from "@openpalm/lib";

const logger = createLogger("admin:setup-deploy");

export type DeployEntry = {
  service: string;
  status: "pending" | "running" | "error";
  label: string;
};

export type DeployPhase = "writing-config" | "pulling-images" | "starting" | "ready";

type DeployState = {
  deploying: boolean;
  setupComplete: boolean;
  deployStatus: DeployEntry[];
  deployError: string | null;
  phase: DeployPhase;
};

let _state: DeployState = {
  deploying: false,
  setupComplete: false,
  deployStatus: [],
  deployError: null,
  phase: "writing-config",
};

export function getDeployState(): DeployState {
  // Reconcile after a server restart: if setup is complete on disk, reflect that.
  if (!_state.setupComplete && !_state.deploying && isSetupComplete(resolveStackDir())) {
    _state.setupComplete = true;
  }
  return { ..._state, deployStatus: [..._state.deployStatus] };
}

export function resetDeployState(): void {
  _state = {
    deploying: false,
    setupComplete: false,
    deployStatus: [],
    deployError: null,
    phase: "writing-config",
  };
}

/**
 * Pre-flight: refuse to deploy if existing containers in this compose
 * project belong to a DIFFERENT OP_HOME than the one we're about to deploy.
 * Without this, two stacks (e.g. dev and host) that share the default
 * "openpalm" project name will silently clobber each other.
 */
async function checkProjectNameCollision(state: ControlPlaneState): Promise<string | null> {
  // Use docker CLI directly — composePs would require running the same
  // compose file set we're about to launch, which is what we're guarding.
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["ps", "-q", "--filter", `label=com.docker.compose.project=${process.env.OP_PROJECT_NAME ?? "openpalm"}`],
      (err, stdout) => {
        if (err) return resolve(null); // docker not running / no permissions — let composeUp surface it
        const ids = stdout.toString().trim().split(/\s+/).filter(Boolean);
        if (ids.length === 0) return resolve(null);
        // Inspect the first container's working_dir label to learn which OP_HOME it belongs to.
        execFile(
          "docker",
          ["inspect", "--format", '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}', ids[0]],
          (err2, stdout2) => {
            if (err2) return resolve(null);
            const runningHome = stdout2.toString().trim();
            if (runningHome && runningHome !== state.homeDir) {
              resolve(
                `Refusing to deploy: docker project "${process.env.OP_PROJECT_NAME ?? "openpalm"}" is already running with OP_HOME=${runningHome}, ` +
                `but this deploy would use OP_HOME=${state.homeDir}. Set OP_PROJECT_NAME to a distinct value in stack.env, ` +
                `or stop the existing stack first.`
              );
              return;
            }
            resolve(null);
          },
        );
      },
    );
  });
}

/** Kick off a background Docker Compose deploy. Returns immediately. */
export function startDeploy(state: ControlPlaneState): void {
  _state.deploying = true;
  _state.deployError = null;
  _state.phase = "writing-config";

  void (async () => {
    try {
      // Pre-flight: detect cross-OP_HOME project-name collision and refuse.
      const collision = await checkProjectNameCollision(state);
      if (collision) {
        logger.error("deploy aborted: project name collision", { error: collision });
        _state.deployError = collision;
        return;
      }

      // Phase 1: write compose files, env, etc.
      await applyInstall(state);
      const services = await buildManagedServices(state);
      _state.deployStatus = services.map(s => ({ service: s, status: "pending", label: "Waiting..." }));

      // Phase 2: pull images. Surface this phase explicitly so the UI can
      // explain the expected wait time (multi-GB images on first install).
      _state.phase = "pulling-images";
      const composeOpts = buildComposeOptions(state);
      const pullResult = await composePull(composeOpts);
      if (!pullResult.ok) {
        const msg = pullResult.stderr?.trim() || "Image pull failed";
        _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "error", label: "Image pull failed" }));
        _state.deployError = msg;
        return;
      }

      // Phase 3: start containers.
      _state.phase = "starting";
      _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "pending", label: "Starting..." }));
      const result = await composeUp({ ...composeOpts, services });

      if (result.ok) {
        _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "running", label: "Running" }));
        _state.setupComplete = true;
        _state.phase = "ready";
      } else {
        const msg = result.stderr ?? "compose up failed";
        _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "error", label: msg }));
        _state.deployError = msg;
      }
    } catch (err) {
      const msg = String(err);
      logger.error("deploy failed", { error: msg });
      _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "error", label: msg }));
      _state.deployError = msg;
    } finally {
      _state.deploying = false;
    }
  })();
}
