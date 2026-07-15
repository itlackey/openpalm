/**
 * GET/PUT /api/assistant/persona — the assistant-owned persona markdown
 * (plan ui-runtime-modes-plan.md Phase 4 step 2, §5.F, §6.4).
 *
 * The ASSISTANT-SCOPED half of the old /admin/assistant endpoint. Persona
 * lives in config/assistant/persona.md. Assistant settings are a BASE
 * capability (every process), so the browser can read/write the persona
 * regardless of admin capability; the guard is capability-based, and the
 * admin session is still required (plan §8.5).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { writeFileAtomic } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
  withAdminBody,
} from '$lib/server/helpers.js';

function personaPath(configDir: string): string {
  return join(configDir, 'assistant', 'persona.md');
}

function readPersona(configDir: string): string {
  const path = personaPath(configDir);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'assistant-settings:read', requestId);
  if (capabilityError) return capabilityError;
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  const state = getState();
  return jsonResponse(
    200,
    {
      personaPath: 'config/assistant/persona.md',
      personaContent: readPersona(state.configDir),
    },
    requestId,
  );
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'assistant-settings:write', requestId);
  if (capabilityError) return capabilityError;

  return withAdminBody(event, async ({ requestId, body }) => {
    if (typeof body.personaContent !== 'string') {
      return errorResponse(400, 'bad_request', 'personaContent must be a string', {}, requestId);
    }

    const state = getState();
    const path = personaPath(state.configDir);
    mkdirSync(join(state.configDir, 'assistant'), { recursive: true });
    const personaContent = body.personaContent.endsWith('\n')
      ? body.personaContent
      : `${body.personaContent}\n`;
    writeFileAtomic(path, personaContent, 0o644);

    return jsonResponse(
      200,
      {
        ok: true,
        personaPath: 'config/assistant/persona.md',
        personaContent,
      },
      requestId,
    );
  });
};
