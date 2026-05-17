/**
 * GET /admin/artifacts/[name] — Get artifact content by name (compose).
 * Returns text/plain with x-artifact-sha256 header.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { errorResponse, requireAuth, getRequestId, getActor, getCallerType } from "$lib/server/helpers.js";
import { appendAudit } from "@openpalm/lib";

const ALLOWED_NAMES = ["compose"] as const;
type ArtifactName = (typeof ALLOWED_NAMES)[number];

const NAME_ALIASES: Record<string, ArtifactName> = {};

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
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
