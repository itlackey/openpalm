import { homedir } from 'node:os';
import { json } from '@sveltejs/kit';
import { detectHostOpenCode, createLogger, isHostAkmAvailable, hostAkmStashPath } from '@openpalm/lib';
import type { RequestHandler } from './$types';

const logger = createLogger('admin:host-status');

export const GET: RequestHandler = () => {
  try {
    const status = detectHostOpenCode();
    const home = homedir();
    const akmStashPath = hostAkmStashPath();
    // "Available" = the host has an initialized AKM (personal config present),
    // the reliable signal — not merely that a ~/akm directory exists.
    const hostAkmAvailable = isHostAkmAvailable();
    return json({
      detected: status.providerCount > 0 || status.credentialCount > 0,
      providerCount: status.providerCount,
      credentialCount: status.credentialCount,
      modelPreferences: status.modelPreferences,
      imageTag: 'latest',
      hostAkmAvailable,
      hostAkmPaths: {
        stash: akmStashPath,
        data: `${home}/.local/share/akm`,
        state: `${home}/.local/state/akm`,
        config: `${home}/.config/akm`,
      },
    });
  } catch (err) {
    // Previously swallowed silently. Log with full detail and surface a
    // `warning` so the UI can tell the user "we couldn't detect host
    // OpenCode" instead of pretending nothing went wrong.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.warn('failed to detect host openpalm/openpalm state', { error: message, stack });
    return json({
      detected: false,
      providerCount: 0,
      credentialCount: 0,
      imageTag: 'latest',
      hostAkmAvailable: false,
      warning: `Could not detect host OpenCode state: ${message}`,
    });
  }
};
