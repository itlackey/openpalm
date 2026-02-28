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
  ensureSecrets,
  discoverStagedChannelYmls,
  buildComposeFileList,
  buildEnvFiles,
  CORE_SERVICES
} from "$lib/server/control-plane.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";
import { afterMutation } from "$lib/server/sync/index.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // 1. Create XDG directories
  ensureXdgDirs();

  // 2. Seed starter OpenCode config (opencode.json + tools/plugins/skills dirs)
  ensureOpenCodeConfig();

  // 3. Write consolidated secrets file
  ensureSecrets(state);

  // 4. Update state and generate artifacts
  applyInstall(state);

  // 5. Discover staged channels and register them in services state.
  const stagedYmls = discoverStagedChannelYmls(state.stateDir);
  const channelNames = stagedYmls.map((p) => {
    const filename = p.split("/").pop() ?? "";
    return filename.replace(/\.yml$/, "");
  }).filter(Boolean);
  for (const name of channelNames) {
    const serviceName = `channel-${name}`;
    if (!(serviceName in state.services)) {
      state.services[serviceName] = "stopped";
    }
  }

  // 6. Run docker compose up with core + all channel overlays
  const dockerCheck = await checkDocker();
  let dockerResult = null;
  if (dockerCheck.ok) {
    dockerResult = await composeUp(state.stateDir, {
      files: buildComposeFileList(state),
      envFiles: buildEnvFiles(state)
    });
  }

  // Config sync — snapshot after apply cycle (best-effort, never blocks)
  await afterMutation(state.configDir, "Apply config");

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

  return jsonResponse(
    200,
    {
      ok: true,
      started,
      dockerAvailable: dockerCheck.ok,
      composeResult: dockerResult
        ? { ok: dockerResult.ok, stderr: dockerResult.stderr }
        : null,
      artifactsDir: `${state.stateDir}/artifacts`
    },
    requestId
  );
};
