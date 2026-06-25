import { json } from "@sveltejs/kit";
import { isSetupComplete, resolveOpenPalmHome } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => {
  const complete = isSetupComplete(resolveOpenPalmHome());
  return json({ ok: true, setupComplete: complete });
};
