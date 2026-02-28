/**
 * GET /admin/artifacts/[name] — Get artifact content by name (compose, caddyfile).
 * Returns text/plain with x-artifact-sha256 header.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { errorResponse, requireAdmin, getRequestId, getActor, getCallerType } from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";

const ALLOWED_NAMES = ["compose", "caddyfile"] as const;
type ArtifactName = (typeof ALLOWED_NAMES)[number];

// Backward compat: "caddy" → "caddyfile"
const NAME_ALIASES: Record<string, ArtifactName> = { caddy: "caddyfile" };

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const rawName = event.params.name as string;
  const name = (NAME_ALIASES[rawName] ?? rawName) as string;

  if (!ALLOWED_NAMES.includes(name as ArtifactName)) {
    appendAudit(state, actor, "artifacts.get", { name: rawName }, false, requestId, callerType);
    return errorResponse(404, "not_found", "Artifact does not exist", { name: rawName }, requestId);
  }

  const artifactName = name as ArtifactName;
  const meta = state.artifactMeta.find((m) => m.name === artifactName);
  appendAudit(state, actor, "artifacts.get", { name: rawName }, true, requestId, callerType);

  return new Response(state.artifacts[artifactName], {
    status: 200,
    headers: {
      "content-type": "text/plain",
      "x-request-id": requestId,
      ...(meta ? { "x-artifact-sha256": meta.sha256 } : {})
    }
  });
};
