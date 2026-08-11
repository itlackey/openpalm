import { json } from '@sveltejs/kit';
import { checkDocker, isSetupComplete, mapDockerError, resolveOpenPalmHome } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { getDeployState, startDeploy } from '$lib/server/setup-deploy.js';
import { errorResponse, getRequestId } from '$lib/server/helpers.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();
  const current = getDeployState(state);

  // Authenticated setup reruns mark setup complete before the deploy finishes.
  // Permit only recovery of a persisted failed deploy; ordinary post-setup
  // calls remain blocked.
  if (isSetupComplete(resolveOpenPalmHome()) && !current.deployError) {
    return errorResponse(409, 'setup_complete', 'Setup is already complete.', {}, requestId);
  }

  const docker = await checkDocker();
  if (!docker.ok) {
    // Same reasoning as setup/complete: the mapper tells not-installed and
    // permission-denied apart from actually-stopped, and only the third is
    // fixed by starting Docker.
    const mapped = mapDockerError(docker.stderr ?? '');
    return errorResponse(503, mapped.code, mapped.message, {}, requestId);
  }

  if (current.deploying) {
    return errorResponse(409, 'install_in_progress', 'A deploy is already running.', {}, requestId);
  }

  startDeploy(state);
  return json({ ok: true });
};
