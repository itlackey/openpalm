const ADMIN_URL = process.env.OPENPALM_ADMIN_API_URL || "http://admin:8100";
const ADMIN_TOKEN = process.env.OPENPALM_ADMIN_TOKEN || "";
const OPENMEMORY_URL = process.env.OPENMEMORY_API_URL || "http://openmemory:8765";
export const USER_ID = process.env.OPENMEMORY_USER_ID || "default_user";

export async function adminFetch(path: string, options?: RequestInit): Promise<string> {
  try {
    const res = await fetch(`${ADMIN_URL}${path}`, {
      ...options,
      headers: {
        "x-admin-token": ADMIN_TOKEN,
        "x-requested-by": "assistant",
        "content-type": "application/json",
        ...options?.headers,
      },
      signal: options?.signal ?? AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    if (!res.ok) return JSON.stringify({ error: true, status: res.status, body });
    return body;
  } catch (err) {
    return JSON.stringify({ error: true, message: err instanceof Error ? err.message : String(err) });
  }
}

export async function memoryFetch(path: string, options?: RequestInit): Promise<string> {
  try {
    const res = await fetch(`${OPENMEMORY_URL}${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...options?.headers },
      signal: options?.signal ?? AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    if (!res.ok) return JSON.stringify({ error: true, status: res.status, body });
    return body;
  } catch (err) {
    return JSON.stringify({ error: true, message: err instanceof Error ? err.message : String(err) });
  }
}
