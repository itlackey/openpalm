import {
  buildServedUiRuntimeConfig,
  parseUiRuntimeConfigJson,
  resolveOpenPalmHome,
  UI_RUNTIME_CONFIG_ENV,
} from '@openpalm/lib';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const NO_STORE = { 'cache-control': 'no-store' };

export const GET: RequestHandler = () => {
  const parsed = parseUiRuntimeConfigJson(process.env[UI_RUNTIME_CONFIG_ENV]);
  if (parsed.status === 'valid') return json(parsed.config, { headers: NO_STORE });
  if (parsed.status === 'invalid') {
    return json({ error: 'invalid_runtime_config' }, { status: 500, headers: NO_STORE });
  }

  // Electron predates the process-config env contract. Derive its locked local
  // connection from the existing harness env without changing that origin-
  // sensitive compatibility surface.
  if (process.env.OP_INSIDE_ELECTRON === '1') {
    return json(buildServedUiRuntimeConfig(resolveOpenPalmHome()), { headers: NO_STORE });
  }

  // The assistant container owns the static runtime-config.json writer. A 404
  // explicitly tells the browser store to use that unchanged fallback.
  return new Response(null, { status: 404, headers: NO_STORE });
};
