import { json } from "@sveltejs/kit";
import { isSetupComplete, resolveStackDir } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => {
  const complete = isSetupComplete(resolveStackDir());
  return json({ ok: true, setupComplete: complete });
};
