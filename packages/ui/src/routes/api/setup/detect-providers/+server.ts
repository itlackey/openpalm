import { json } from "@sveltejs/kit";
import { detectLocalProviders } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  try {
    const providers = await detectLocalProviders();
    return json({ ok: true, providers });
  } catch (err) {
    return json({ ok: false, error: "detection_failed", message: String(err) }, { status: 500 });
  }
};
