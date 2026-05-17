import {
  getRequestId,
  jsonResponse,
  requireAdmin,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  applyInstall,
  createLogger,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureSecrets,
  buildComposeOptions,
  buildManagedServices,
  CORE_SERVICES,
  ensureHomeDirs,
  composeUp,
  checkDocker,
} from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("install");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("install request received", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // 1. Ensure home directory tree exists
  logger.info("ensuring home directories and seeding config", { requestId });
  ensureHomeDirs();

  // 2. Seed starter OpenCode config (opencode.json + tools/plugins/skills dirs)
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();

  // 3. Write consolidated secrets file
  ensureSecrets(state);

  // 4. Update state and generate artifacts (audit recorded inside lib)
  await applyInstall(state, { actor, requestId, callerType });

  // 5. Run docker compose up — managed services derived from compose config
  const managedServices = await buildManagedServices(state);
  logger.info("checking Docker availability", { requestId });
  const dockerCheck = await checkDocker();
  let dockerResult = null;
  if (dockerCheck.ok) {
    logger.info("starting compose up", { requestId, services: managedServices });
    dockerResult = await composeUp({
      ...buildComposeOptions(state),
      services: managedServices
    });
  }

  const started = [...CORE_SERVICES];

  logger.info("install completed", { requestId, started, dockerAvailable: dockerCheck.ok, composeOk: dockerResult?.ok ?? null });

  return jsonResponse(
    200,
    {
      ok: true,
      started,
      dockerAvailable: dockerCheck.ok,
      composeResult: dockerResult
        ? { ok: dockerResult.ok, stderr: dockerResult.stderr }
        : null
    },
    requestId
  );
};
