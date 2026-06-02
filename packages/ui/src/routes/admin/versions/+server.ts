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

  return json({ imageTag, inElectron });
};
