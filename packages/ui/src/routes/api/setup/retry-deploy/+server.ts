import { json } from '@sveltejs/kit';
import { checkDocker, isSetupComplete, resolveOpenPalmHome } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { getDeployState, startDeploy } from '$lib/server/setup-deploy.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
  if (isSetupComplete(resolveOpenPalmHome())) {
    return json({ ok: false, error: 'setup_complete', message: 'Setup is already complete.' }, { status: 409 });
  }

  const docker = await checkDocker();
  if (!docker.ok) {
    return json({ ok: false, error: 'docker_unavailable', message: "Docker isn't running. Start Docker, then retry deploy." }, { status: 503 });
  }

  const current = getDeployState(getState());
  if (current.deploying) {
    return json({ ok: false, error: 'install_in_progress', message: 'A deploy is already running.' }, { status: 409 });
  }

  startDeploy(getState());
  return json({ ok: true });
};
