/**
 * Server-side load for the Connections page.
 *
 * Pre-loads current connection values (masked) and status from the admin API
 * so the page can render with data immediately.
 * Uses the admin token from the request cookie or header if available.
 * Falls back to empty state gracefully if the API is unreachable or unauthenticated.
 */
import type { PageServerLoad } from "./$types";
import { readSecretsEnvFile, ALLOWED_CONNECTION_KEYS, maskConnectionValue } from "$lib/server/control-plane.js";
import { getState } from "$lib/server/state.js";

export const load: PageServerLoad = async () => {
  try {
    const state = getState();
    const raw = readSecretsEnvFile(state.configDir);

    const connections: Record<string, string> = {};
    for (const key of ALLOWED_CONNECTION_KEYS) {
      connections[key] = maskConnectionValue(key, raw[key] ?? "");
    }

    return { connections };
  } catch {
    // Return empty state — the page will handle loading via client-side fetch
    const connections: Record<string, string> = {};
    for (const key of ALLOWED_CONNECTION_KEYS) {
      connections[key] = "";
    }
    return { connections };
  }
};
