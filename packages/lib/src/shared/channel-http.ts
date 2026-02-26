import { json } from "./http.ts";

const MAX_JSON_BODY_BYTES = 1_048_576;

export function rejectPayloadTooLarge(req: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Response | null {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) return json(413, { error: "payload_too_large" });
  return null;
}

export async function readJsonObject<T extends Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}
