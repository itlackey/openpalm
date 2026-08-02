/**
 * GET /api/host/automations — List automation configs from knowledge/tasks/.
 *
 * Read-only endpoint. Automations are AKM task files at
 * ${stashDir}/tasks/*.yml. The scheduler runs as a co-process inside the
 * assistant; `akm task run <id>` handles execution.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  requireCapability,
  getRequestId,
} from "$lib/server/helpers.js";
import { listTaskFiles, loadAutomations } from "@openpalm/lib";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();

  const parsedByFile = new Map(loadAutomations(state.stashDir).map((config) => [config.fileName, config]));
  const automations = listTaskFiles(state.stashDir).map((file) => {
    const config = parsedByFile.get(file.name);
    if (!config) {
      return {
        name: file.name.slice(0, -4),
        description: 'AKM could not parse this task. Edit or delete the raw file.',
        schedule: '',
        timezone: 'UTC',
        enabled: false,
        valid: false,
        action: { type: 'shell' as const },
        on_failure: 'log' as const,
        fileName: file.name,
      };
    }
    return {
      name: config.name,
      description: config.description,
      schedule: config.schedule,
      timezone: config.timezone,
      enabled: config.enabled,
      valid: true,
      action: {
        type: config.action.type,
        content: config.action.content,
        agent: config.action.agent
      },
      on_failure: config.on_failure,
      fileName: config.fileName,
    };
  });

  return jsonResponse(200, { automations }, requestId);
};
