import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { B as BUILTIN_CHANNELS } from './index-CyXiysyI.js';
import { CORE_AUTOMATIONS } from './index2-Z_OhWSa0.js';
import { d as discoverAllSnippets } from './snippet-discovery-CQEtAH6T.js';
import { l as log } from './init-C6nnJEAN.js';
import './index-CoD1IJuy.js';
import './snippet-types-B-BcGjF6.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';

const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  let snippets = [];
  try {
    snippets = await discoverAllSnippets();
  } catch (error) {
    log.warn("Snippet discovery failed for /snippets", { error: String(error) });
    snippets = [];
  }
  return json(200, {
    ok: true,
    discoveredSnippets: snippets,
    builtInChannels: Object.entries(BUILTIN_CHANNELS).map(([key, def]) => ({
      key,
      name: def.name,
      containerPort: def.containerPort,
      rewritePath: def.rewritePath,
      env: def.env
    })),
    coreAutomations: CORE_AUTOMATIONS.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      schedule: a.schedule
    }))
  });
};

export { GET };
//# sourceMappingURL=_server.ts-FkbXrNde.js.map
