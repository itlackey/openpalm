import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { patchSecretsEnvFile, readStackEnv, writeFileAtomic } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  withAdminBody,
} from '$lib/server/helpers.js';

const DEFAULT_PROJECT_NAME = 'openpalm';
const DEFAULT_ASSISTANT_BIND_ADDRESS = '127.0.0.1';
const LAN_ASSISTANT_BIND_ADDRESS = '0.0.0.0';
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

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

function normalizeProjectName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim() || DEFAULT_PROJECT_NAME;
  if (value.length > 63) return null;
  return PROJECT_NAME_RE.test(value) ? value : null;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  const state = getState();
  const env = readStackEnv(state.homeDir);

  return jsonResponse(
    200,
    {
      projectName: env.OP_PROJECT_NAME?.trim() || DEFAULT_PROJECT_NAME,
      lanExposureEnabled: (env.OP_ASSISTANT_BIND_ADDRESS?.trim() || DEFAULT_ASSISTANT_BIND_ADDRESS) === LAN_ASSISTANT_BIND_ADDRESS,
      stackEnvPath: 'knowledge/env/stack.env',
      personaPath: 'config/assistant/persona.md',
      personaContent: readPersona(state.configDir),
    },
    requestId,
  );
};

export const PUT: RequestHandler = async (event) =>
  withAdminBody(event, async ({ requestId, body }) => {
    const projectName = normalizeProjectName(body.projectName);
    if (!projectName) {
      return errorResponse(
        400,
        'bad_request',
        'projectName must be 1-63 chars of lowercase letters, numbers, dashes, or underscores.',
        {},
        requestId,
      );
    }

    if (typeof body.personaContent !== 'string') {
      return errorResponse(400, 'bad_request', 'personaContent must be a string', {}, requestId);
    }

    if (typeof body.lanExposureEnabled !== 'boolean') {
      return errorResponse(400, 'bad_request', 'lanExposureEnabled must be a boolean', {}, requestId);
    }

    const state = getState();
    patchSecretsEnvFile(state.homeDir, {
      OP_PROJECT_NAME: projectName,
      OP_ASSISTANT_BIND_ADDRESS: body.lanExposureEnabled ? LAN_ASSISTANT_BIND_ADDRESS : DEFAULT_ASSISTANT_BIND_ADDRESS,
    });

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
        projectName,
        lanExposureEnabled: body.lanExposureEnabled,
        stackEnvPath: 'knowledge/env/stack.env',
        personaPath: 'config/assistant/persona.md',
        personaContent,
      },
      requestId,
    );
  });
