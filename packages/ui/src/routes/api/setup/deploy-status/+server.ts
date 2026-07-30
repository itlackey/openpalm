import { json } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { resolveHostUiPort, resolvePublishedUiPort, STACK_DEFAULTS } from "@openpalm/lib";
import { getDeployState } from "$lib/server/setup-deploy.js";
import type { RequestHandler } from "./$types";

// Defaults mirror packages/cli/src/commands/install.ts and dev-setup.sh.
// Source the values from env so the UI does not hardcode them in DeployStep.
// Guardian is omitted: it has no host port mapping (network-only service).
function resolvePorts() {
  return {
    admin: resolveHostUiPort(undefined, process.env),
    ui: resolvePublishedUiPort(process.env),
    assistant: Number(process.env.OP_ASSISTANT_PORT) || STACK_DEFAULTS.ports.assistant,
  };
}

export const GET: RequestHandler = () => {
  const state = getDeployState(getState());
  return json({
    ok: true,
    setupComplete: state.setupComplete,
    deploying:     state.deploying,
    deployStatus:  state.deployStatus,
    deployError:   state.deployError,
    imageWarning:  state.imageWarning,
    phase:         state.phase,
    ports:         resolvePorts(),
  });
};
