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

type DeployState = {
  deploying: boolean;
  setupComplete: boolean;
  deployStatus: DeployEntry[];
  deployError: string | null;
};

let _state: DeployState = {
  deploying: false,
  setupComplete: false,
  deployStatus: [],
  deployError: null,
};

export function getDeployState(): DeployState {
  // Reconcile after a server restart: if setup is complete on disk, reflect that.
  if (!_state.setupComplete && !_state.deploying && isSetupComplete(resolveStackDir())) {
    _state.setupComplete = true;
  }
  return { ..._state, deployStatus: [..._state.deployStatus] };
}

export function resetDeployState(): void {
  _state = { deploying: false, setupComplete: false, deployStatus: [], deployError: null };
}

/** Kick off a background Docker Compose deploy. Returns immediately. */
export function startDeploy(state: ControlPlaneState): void {
  _state.deploying = true;
  _state.deployError = null;

  void (async () => {
    try {
      await applyInstall(state);
      const services = await buildManagedServices(state);
      _state.deployStatus = services.map(s => ({ service: s, status: "pending", label: "Starting..." }));

      const result = await composeUp({ ...buildComposeOptions(state), services });

      if (result.ok) {
        _state.deployStatus = _state.deployStatus.map(e => ({ ...e, status: "running", label: "Running" }));
        _state.setupComplete = true;
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
