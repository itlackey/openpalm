import {
  getRequestId,
  jsonResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { withSerialQueue } from "$lib/server/serial-queue.js";
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

  return withSerialQueue("admin:install", async () => {
    const state = getState();

    // 1. Ensure home directory tree exists
    logger.info("ensuring home directories and seeding config", { requestId });
    ensureHomeDirs();

    // 2. Seed starter OpenCode config (opencode.json + tools/plugins/skills dirs)
    ensureOpenCodeConfig();
    ensureOpenCodeSystemConfig();

    // 3. Write consolidated secrets file
    ensureSecrets(state);

    // 4. Update state and generate artifacts. OpenCode session logs are the
    // audit trail (D6a in docs/technical/auth-and-proxy-refactor-plan.md).
    await applyInstall(state);

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
  });
};
