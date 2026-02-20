import { json } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';
import { parseJsonc } from '@openpalm/lib';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN, OPENCODE_CONFIG_PATH } from '$lib/server/env';
import { getSetupManager } from '$lib/server/stores';
import { ensureOpencodeConfigPath } from '$lib/server/helpers';

export const GET: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const state = getSetupManager().getState();
  ensureOpencodeConfigPath();
  const configRaw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
  const config = parseJsonc(configRaw) as { plugin?: string[] };
  return json({ plugins: config.plugin ?? [], setupState: state });
};
