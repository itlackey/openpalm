import { json } from "@sveltejs/kit";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getState } from "$lib/server/state.js";
import { requireAdmin, getRequestId, errorResponse } from "$lib/server/helpers.js";
import { readVersions, writeVersions, SERVICE_VERSION_KEYS, PLATFORM_VERSION, formatForDisplay, parseEnvFile, mergeEnvContent } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const ALLOWED_KEYS = new Set<string>([...SERVICE_VERSION_KEYS, "OP_AUTO_UPDATE"]);

function stackEnvPath(): string {
  return `${getState().stashDir}/env/stack.env`;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  if (!state.stackDir) {
    return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  }

  const path = stackEnvPath();
  const env = existsSync(path) ? parseEnvFile(path) : {};

  return json({
    versions: readVersions(state),
    platformVersion: formatForDisplay(PLATFORM_VERSION),
    autoUpdate: env["OP_AUTO_UPDATE"] !== "false",
  });
};

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  if (!state.stackDir) {
    return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  }

  let body: { versions?: Record<string, string> };
  try {
    body = (await event.request.json()) as { versions?: Record<string, string> };
  } catch {
    return errorResponse(400, "invalid_body", "Request body must be JSON", {}, requestId);
  }

  const versions = body?.versions;
  if (!versions || typeof versions !== "object") {
    return errorResponse(400, "invalid_body", "Body must include a versions object", {}, requestId);
  }

  const versionUpdates: Record<string, string> = {};
  const settingUpdates: Record<string, string> = {};

  for (const [key, value] of Object.entries(versions)) {
    if (!ALLOWED_KEYS.has(key)) {
      return errorResponse(400, "unknown_version_key", `Unknown key: ${key}`, {}, requestId);
    }
    if (typeof value !== "string") {
      return errorResponse(400, "invalid_version_value", `Value for ${key} must be a string`, {}, requestId);
    }
    if (key === "OP_AUTO_UPDATE") {
      settingUpdates[key] = value;
    } else {
      versionUpdates[key] = value;
    }
  }

  if (Object.keys(versionUpdates).length > 0) writeVersions(state, versionUpdates);

  if (Object.keys(settingUpdates).length > 0) {
    const path = stackEnvPath();
    const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
    writeFileSync(path, mergeEnvContent(current, settingUpdates), { mode: 0o600 });
  }

  return json({ ok: true, versions: readVersions(state) });
};
