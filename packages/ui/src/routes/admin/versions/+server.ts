import { existsSync } from "node:fs";
import { json } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { requireAdmin, getRequestId, errorResponse } from "$lib/server/helpers.js";
import { parseEnvFile } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  if (!state.stackDir) return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  const stackEnvPath = `${state.stashDir}/env/stack.env`;
  const envVars = existsSync(stackEnvPath) ? parseEnvFile(stackEnvPath) : {};
  const imageTag = envVars.OP_IMAGE_TAG ?? "latest";

  const inElectron = process.env.OP_INSIDE_ELECTRON === "1";

  // Desktop (Electron) app version + update info, injected by buildUIServerEnv()
  // in packages/electron/src/main.ts. Present only when running inside Electron.
  // OP_ELECTRON_LATEST_* are set only when the app's GitHub update check found a
  // newer release, so latestVersion non-null ⇒ an update is available.
  const electronVersion = process.env.OP_ELECTRON_VERSION ?? null;
  const electronLatestVersion = process.env.OP_ELECTRON_LATEST_VERSION ?? null;
  const electronLatestUrl = process.env.OP_ELECTRON_LATEST_URL ?? null;

  return json({
    imageTag,
    inElectron,
    electronVersion,
    electronLatestVersion,
    electronLatestUrl,
    electronUpdateAvailable: !!electronLatestVersion,
  });
};
