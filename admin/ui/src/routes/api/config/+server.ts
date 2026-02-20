import { json } from '@sveltejs/kit';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseJsonc } from '@openpalm/lib';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN, OPENCODE_CONFIG_PATH } from '$lib/server/env';
import { ensureOpencodeConfigPath, snapshotFile, controllerAction } from '$lib/server/helpers';

export const GET: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  ensureOpencodeConfigPath();
  return new Response(readFileSync(OPENCODE_CONFIG_PATH, "utf8"), {
    headers: { "content-type": "text/plain" }
  });
};

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { config: string; restart?: boolean };
  const parsed = parseJsonc(body.config);
  if (typeof parsed !== "object") {
    return json({ error: "The configuration file has a syntax error" }, { status: 400 });
  }
  // Recursively check for "allow" values in the permission tree
  function hasAllowValue(obj: unknown): boolean {
    if (obj === "allow") return true;
    if (obj && typeof obj === "object") {
      return Object.values(obj as Record<string, unknown>).some(hasAllowValue);
    }
    return false;
  }
  const permissions = (parsed as Record<string, unknown>).permission;
  if (permissions && hasAllowValue(permissions)) {
    return json({ error: "This change would weaken security protections and was blocked" }, { status: 400 });
  }
  ensureOpencodeConfigPath();
  const backup = snapshotFile(OPENCODE_CONFIG_PATH);
  writeFileSync(OPENCODE_CONFIG_PATH, body.config, "utf8");
  if (body.restart ?? true) await controllerAction("restart", "opencode-core", "config update");
  return json({ ok: true, backup });
};
