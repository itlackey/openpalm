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
  appendAudit,
  ensureXdgDirs,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureMemoryDir,
  ensureSecrets,
  discoverChannelOverlays,
  buildComposeFileList,
  buildEnvFiles,
  buildManagedServices,
  CORE_SERVICES
} from "$lib/server/control-plane.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";
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

  // 1. Create XDG directories
  logger.info("ensuring XDG directories and seeding config", { requestId });
  ensureXdgDirs();

  // 2. Seed starter OpenCode config (opencode.json + tools/plugins/skills dirs)
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureMemoryDir();

  // 3. Write consolidated secrets file
  ensureSecrets(state);

  // 4. Update state and generate artifacts
  applyInstall(state);

  // 5. Discover channel overlays and register them in services state.
  const channelYmls = discoverChannelOverlays(state.configDir);
  const channelNames = channelYmls.map((p) => {
    const filename = p.split("/").pop() ?? "";
    return filename.replace(/^channel-/, "").replace(/\.yml$/, "");
  }).filter(Boolean);
  for (const name of channelNames) {
    const serviceName = `channel-${name}`;
    if (!(serviceName in state.services)) {
      state.services[serviceName] = "stopped";
    }
  }

  // 6. Run docker compose up with core + all channel overlays
  logger.info("checking Docker availability", { requestId });
  const dockerCheck = await checkDocker();
  let dockerResult = null;
  if (dockerCheck.ok) {
    logger.info("starting compose up", { requestId, channels: channelNames });
    dockerResult = await composeUp(state.configDir, {
      files: buildComposeFileList(state),
      envFiles: buildEnvFiles(state),
      services: buildManagedServices(state)
    });
  }

  appendAudit(
    state,
    actor,
    "install",
    {
      dockerAvailable: dockerCheck.ok,
      composeResult: dockerResult?.ok ?? null,
      channels: channelNames
    },
    true,
    requestId,
    callerType
  );

  const started = [
    ...CORE_SERVICES,
    ...channelNames.map((name) => `channel-${name}`)
  ];

  logger.info("install completed", { requestId, started, dockerAvailable: dockerCheck.ok, composeOk: dockerResult?.ok ?? null });

  return jsonResponse(
    200,
    {
      ok: true,
      started,
      dockerAvailable: dockerCheck.ok,
      composeResult: dockerResult
        ? { ok: dockerResult.ok, stderr: dockerResult.stderr }
        : null,
      artifactsDir: `${state.configDir}/components`
    },
    requestId
  );
};
