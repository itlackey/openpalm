import { existsSync } from 'node:fs';
import { json } from '@sveltejs/kit';
import { detectHostOpenCode, createLogger, hostAkmStashPath } from '@openpalm/lib';
import type { RequestHandler } from './$types';

const logger = createLogger('admin:host-status');

export const GET: RequestHandler = () => {
  try {
    const status = detectHostOpenCode();
    const stashPath = hostAkmStashPath();
    // "Available" = the host has a ~/akm stash directory.
    const hostAkmAvailable = existsSync(stashPath);
    return json({
      detected: status.providerCount > 0 || status.credentialCount > 0,
      providerCount: status.providerCount,
      credentialCount: status.credentialCount,
      modelPreferences: status.modelPreferences,
      imageTag: 'latest',
      hostAkmAvailable,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.warn('failed to detect host openpalm state', { error: message, stack });
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
