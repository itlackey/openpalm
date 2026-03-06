import { GLOBAL_USER_ID, STACK_USER_ID } from "../plugins/memory-lib.ts";

const ADMIN_URL = process.env.OPENPALM_ADMIN_API_URL || "http://admin:8100";
const ADMIN_TOKEN = process.env.OPENPALM_ADMIN_TOKEN || "";
const OPENMEMORY_URL = process.env.OPENMEMORY_API_URL || "http://openmemory:8765";
export const USER_ID = process.env.OPENMEMORY_USER_ID || "default_user";
export { GLOBAL_USER_ID, STACK_USER_ID };

let userProvisionPromise: Promise<void> | null = null;

type ProvisionResult = { ok: true } | { ok: false; error: string };

async function provisionOpenMemoryUser(userId: string): Promise<ProvisionResult> {
  const appName = 'openpalm-assistant';
  const sseController = new AbortController();
  const timeout = setTimeout(() => sseController.abort(), 10_000);

  try {
    const sseRes = await fetch(
      `${OPENMEMORY_URL}/mcp/${appName}/sse/${encodeURIComponent(userId)}`,
      { signal: sseController.signal },
    ).catch(() => null);

    if (!sseRes || !sseRes.ok || !sseRes.body) {
      clearTimeout(timeout);
      return { ok: false, error: sseRes ? `SSE HTTP ${sseRes.status}` : 'SSE connection failed' };
    }

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    const readNextEvent = async (timeoutMs = 5_000): Promise<{ event: string; data: string } | null> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = Math.max(deadline - Date.now(), 100);
        const timeoutRace = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), remaining),
        );
        const chunk = await Promise.race([reader.read(), timeoutRace]);
        if (!chunk || (chunk as { done: boolean }).done) return null;
        sseBuffer += decoder.decode((chunk as { value: Uint8Array }).value, { stream: true });
        const eventMatch = sseBuffer.match(/event:\s*(\S+)\r?\n(?:data:\s*(.*)\r?\n)?\r?\n/);
        if (eventMatch) {
          sseBuffer = sseBuffer.slice((eventMatch.index ?? 0) + eventMatch[0].length);
          return { event: eventMatch[1], data: eventMatch[2] || '' };
        }
      }
      return null;
    };

    const endpointEvt = await readNextEvent(5_000);
    if (!endpointEvt || endpointEvt.event !== 'endpoint' || !endpointEvt.data) {
      clearTimeout(timeout);
      sseController.abort();
      return { ok: false, error: 'No endpoint event received from SSE' };
    }

    const messagesUrl = `${OPENMEMORY_URL}${endpointEvt.data}`;

    await fetch(messagesUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: appName, version: '1.0.0' },
        },
      }),
    }).catch(() => null);

    await readNextEvent(5_000);

    await fetch(messagesUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    }).catch(() => null);

    await new Promise((resolve) => setTimeout(resolve, 300));

    await fetch(messagesUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'add_memories',
          arguments: {
            text: `User ${userId} account provisioned by assistant-tools.`,
          },
        },
      }),
    }).catch(() => null);

    await readNextEvent(8_000);

    clearTimeout(timeout);
    sseController.abort();
    return { ok: true };
  } catch (err) {
    clearTimeout(timeout);
    sseController.abort();
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: true };
    }
    return { ok: false, error: String(err) };
  }
}

export async function ensureMemoryUserProvisioned(): Promise<void> {
  if (userProvisionPromise) {
    return userProvisionPromise;
  }

  userProvisionPromise = (async () => {
    const result = await provisionOpenMemoryUser(USER_ID);
    if (!result.ok) {
      console.warn(`[assistant-tools] Unable to pre-provision OpenMemory user '${USER_ID}': ${result.error}`);
    }
  })();

  await userProvisionPromise;
}

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
    await ensureMemoryUserProvisioned();
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
