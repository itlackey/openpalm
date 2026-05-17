import type { RequestHandler } from './$types';
import { readFileSync, existsSync } from 'node:fs';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  requireAdmin,
} from '$lib/server/helpers.js';

const NEXT_STEPS = [
  "Run `opencode auth` (or use opencode.ai/connect) to add your API key to OpenCode's credential store.",
  'The model and provider settings above are already applied.',
  'If you use a custom endpoint, verify the baseURL in the providers block matches your setup.',
];

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const configPath = `${state.configDir}/assistant/opencode.json`;

  if (!existsSync(configPath)) {
    return errorResponse(404, 'not_found', 'opencode.json has not been generated yet. Save capability assignments first.', {}, requestId);
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.warn('[capabilities.export.opencode] Failed to read opencode.json', e);
    return errorResponse(500, 'internal_error', 'Failed to read opencode.json', {}, requestId);
  }

  const payload = {
    ...(config as Record<string, unknown>),
    _nextSteps: NEXT_STEPS,
  };

  return new Response(JSON.stringify(payload, null, 2) + '\n', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="opencode.json"',
      'x-request-id': requestId,
    },
  });
};
