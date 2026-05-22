import { json } from "@sveltejs/kit";
import { getDeployState } from "$lib/server/setup-deploy.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => {
  const state = getDeployState();
  return json({
    ok: true,
    setupComplete: state.setupComplete,
    deploying:     state.deploying,
    deployStatus:  state.deployStatus,
    deployError:   state.deployError,
    phase:         state.phase,
  });
};
