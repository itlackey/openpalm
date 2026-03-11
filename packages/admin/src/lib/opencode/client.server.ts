/**
 * OpenCode REST API client wrapper.
 *
 * Provides typed access to the OpenCode server running alongside the admin.
 * All functions handle connectivity errors gracefully, returning empty/default
 * values when OpenCode is not available rather than throwing.
 */

const OPENCODE_BASE_URL =
  process.env.OPENPALM_OPENCODE_URL ?? "http://localhost:4096";

export type OpenCodeProvider = {
  id: string;
  name?: string;
  [key: string]: unknown;
};

/**
 * Fetch the list of configured providers from the OpenCode REST API.
 * Returns an empty array if OpenCode is unreachable or returns an error.
 */
export async function getOpenCodeProviders(): Promise<OpenCodeProvider[]> {
  try {
    const res = await fetch(`${OPENCODE_BASE_URL}/providers`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data)) return data as OpenCodeProvider[];
    if (data && Array.isArray(data.providers)) return data.providers as OpenCodeProvider[];
    return [];
  } catch {
    return [];
  }
}
