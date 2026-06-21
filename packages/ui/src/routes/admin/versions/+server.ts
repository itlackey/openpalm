import { json } from "@sveltejs/kit";
import { getState } from "$lib/server/state.js";
import { requireAdmin, getRequestId, errorResponse } from "$lib/server/helpers.js";
import { readVersions, writeVersions, ALL_VERSION_KEYS, PLATFORM_VERSION, formatForDisplay } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

/**
 * GET /admin/versions — read the stack's version pins from stack.env.
 *
 * Returns every key in ALL_VERSION_KEYS (Docker image tags + npm package pins),
 * falling back to documented defaults for any that are unset, plus the running
 * control-plane version (PLATFORM_VERSION) for the read-only header line.
 *
 * No Docker Hub / npm registry lookups — version selection is now a plain
 * stack.env edit (exact tags / "latest" / "next" for images; semver ranges for
 * npm packages). Update detection is the operator's call, not a poll.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  if (!state.stackDir) {
    return errorResponse(503, "not_initialized", "Stack directory not configured", {}, requestId);
  }

  return json({
    versions: readVersions(state),
    platformVersion: formatForDisplay(PLATFORM_VERSION),
  });
};

/**
 * PATCH /admin/versions — write version pins to stack.env.
 *
 * Body: `{ versions: Record<string, string> }`. Every key is validated against
 * the ALL_VERSION_KEYS allowlist before writing, so a typo or hostile caller
 * cannot smuggle arbitrary env into the stack config. The change takes effect on
 * the next `POST /admin/update` (recreate), which the UI fires right after.
 */
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

  const allowed = new Set<string>(ALL_VERSION_KEYS);
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(versions)) {
    if (!allowed.has(key)) {
      return errorResponse(400, "unknown_version_key", `Unknown version key: ${key}`, {}, requestId);
    }
    if (typeof value !== "string") {
      return errorResponse(400, "invalid_version_value", `Version for ${key} must be a string`, {}, requestId);
    }
    updates[key] = value;
  }

  writeVersions(state, updates);

  return json({ ok: true, versions: readVersions(state) });
};
