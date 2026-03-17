import { GLOBAL_USER_ID, STACK_USER_ID } from "../plugins/memory-lib.ts";

const MEMORY_URL = process.env.MEMORY_API_URL || "http://memory:8765";
const MEMORY_AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN || "";
export const USER_ID = process.env.MEMORY_USER_ID || "default_user";
export { GLOBAL_USER_ID, STACK_USER_ID };

let userProvisionPromise: Promise<void> | null = null;

type ProvisionResult = { ok: true } | { ok: false; error: string };

async function provisionMemoryUser(userId: string): Promise<ProvisionResult> {
  try {
    const authHeaders: Record<string, string> = MEMORY_AUTH_TOKEN
      ? { authorization: `Bearer ${MEMORY_AUTH_TOKEN}` }
      : {};
    const res = await fetch(`${MEMORY_URL}/api/v1/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ user_id: userId }),
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false, error: 'User provision failed' };
  }
}

export async function ensureMemoryUserProvisioned(): Promise<void> {
  if (userProvisionPromise) {
    return userProvisionPromise;
  }

  userProvisionPromise = (async () => {
    const result = await provisionMemoryUser(USER_ID);
    if (!result.ok) {
      console.warn(`[assistant-tools] Unable to pre-provision memory user '${USER_ID}': ${result.error}`);
    }
  })();

  await userProvisionPromise;
}

export async function memoryFetch(path: string, options?: RequestInit): Promise<string> {
  try {
    await ensureMemoryUserProvisioned();
    const authHeaders: Record<string, string> = MEMORY_AUTH_TOKEN
      ? { authorization: `Bearer ${MEMORY_AUTH_TOKEN}` }
      : {};
    const res = await fetch(`${MEMORY_URL}${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...authHeaders, ...options?.headers },
      signal: options?.signal ?? AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    if (!res.ok) return JSON.stringify({ error: true, status: res.status, body });
    return body;
  } catch (err) {
    return JSON.stringify({ error: true, message: err instanceof Error ? err.message : String(err) });
  }
}

export function memoryResponseHasError(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return parsed?.error === true;
  } catch {
    return false;
  }
}

export function resolveMemoryScopeUserId(scope?: string): string {
  if (scope === "stack") return STACK_USER_ID;
  if (scope === "global") return GLOBAL_USER_ID;
  return USER_ID;
}
