import { json } from '@sveltejs/kit';
import { checkDocker, isSetupComplete, resolveOpenPalmHome } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { getDeployState, startDeploy } from '$lib/server/setup-deploy.js';
import { errorResponse, getRequestId } from '$lib/server/helpers.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);

  if (isSetupComplete(resolveOpenPalmHome())) {
    return errorResponse(409, 'setup_complete', 'Setup is already complete.', {}, requestId);
  }

  const docker = await checkDocker();
  if (!docker.ok) {
    return errorResponse(503, 'docker_unavailable', "Docker isn't running. Start Docker, then retry deploy.", {}, requestId);
  }

  const current = getDeployState(getState());
  if (current.deploying) {
    return errorResponse(409, 'install_in_progress', 'A deploy is already running.', {}, requestId);
  }

  startDeploy(getState());
  return json({ ok: true });
};
