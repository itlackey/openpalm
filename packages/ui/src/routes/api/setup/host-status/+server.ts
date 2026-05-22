import { homedir } from 'node:os';
import { json } from '@sveltejs/kit';
import { detectHostOpenCode } from '@openpalm/lib';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
  try {
    const status = detectHostOpenCode();
    const home = homedir();
    return json({
      detected: status.providerCount > 0 || status.credentialCount > 0,
      providerCount: status.providerCount,
      credentialCount: status.credentialCount,
      imageTag: process.env.OP_IMAGE_TAG ?? 'dev',
      hostAkmPaths: {
        stash: `${home}/akm`,
        data: `${home}/.local/share/akm`,
        state: `${home}/.local/state/akm`,
        cache: `${home}/.cache/akm`,
        config: `${home}/.config/akm`,
      },
    });
  } catch {
    return json({ detected: false, providerCount: 0, credentialCount: 0, imageTag: 'dev' });
  }
};
