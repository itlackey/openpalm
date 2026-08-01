import { json } from "@sveltejs/kit";
import { detectLocalProviders } from "@openpalm/lib";
import { errorResponse, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  try {
    const providers = await detectLocalProviders();
    return json({ ok: true, providers });
  } catch (err) {
    return errorResponse(500, "detection_failed", String(err), {}, getRequestId(event));
  }
};
