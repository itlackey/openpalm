export function isVikingConfigured(): boolean {
  return Boolean(process.env.OPENVIKING_URL) && Boolean(process.env.OPENVIKING_API_KEY);
}

export async function vikingFetch(path: string, options?: RequestInit): Promise<string> {
  const url = process.env.OPENVIKING_URL || "";
  const apiKey = process.env.OPENVIKING_API_KEY || "";
  if (!url || !apiKey) {
    return JSON.stringify({ error: true, message: "OpenViking is not configured" });
  }
  try {
    const res = await fetch(`${url}/api/v1${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...options?.headers,
        "x-api-key": apiKey,
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

export function vikingResponseHasError(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return parsed?.error === true;
  } catch {
    return false;
  }
}
