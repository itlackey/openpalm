import { readFileSync, existsSync } from 'node:fs';
import { json } from "@sveltejs/kit";
import { authJsonPath } from "@openpalm/lib";
import { getOpenCodeClient } from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import type { RequestHandler } from "./$types";

function selectedModels(): { llm?: string; small?: string } {
  try {
    const path = `${getState().configDir}/assistant/opencode.json`;
    if (!existsSync(path)) return {};
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return {
      ...(typeof data.model === 'string' && data.model ? { llm: data.model } : {}),
      ...(typeof data.small_model === 'string' && data.small_model ? { small: data.small_model } : {}),
    };
  } catch {
    return {};
  }
}

/** Providers that have credentials stored in OP_HOME auth.json (API key or OAuth). */
function authJsonConnected(): string[] {
  try {
    const path = authJsonPath(getState());
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return Object.keys(data ?? {});
  } catch {
    return [];
  }
}

export const GET: RequestHandler = async () => {
  try {
    const client = getOpenCodeClient();
    const available = await client.isAvailable();
    if (!available) return json({ ok: true, available: false, providers: [] });

    // proxy() gives the raw catalog including the connected[] env-detection list
    const [catalog, auth] = await Promise.all([
      client.proxy('/provider'),
      client.getProviderAuth(),
    ]);

    const raw = (catalog.ok ? catalog.data : {}) as { all?: unknown[]; connected?: string[] };
    const providers = Array.isArray(raw.all) ? raw.all : [];
    // env-var detected providers ∪ auth.json credential providers = truly connected
    const connected = Array.from(new Set([...(raw.connected ?? []), ...authJsonConnected()]));

    return json({ ok: true, available: true, providers, auth, connected, selectedModels: selectedModels() });
  } catch {
    return json({ ok: true, available: false, providers: [] });
  }
};
