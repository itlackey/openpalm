import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { g as getSetupManager, a as getStackManager, l as log } from './init-C6nnJEAN.js';
import { d as discoverAllSnippets } from './snippet-discovery-CQEtAH6T.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import './snippet-types-B-BcGjF6.js';

const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const setupManager = await getSetupManager();
  const stackManager = await getStackManager();
  let snippets = [];
  try {
    snippets = await discoverAllSnippets();
  } catch (error) {
    log.warn("Snippet discovery failed for /state", { error: String(error) });
    snippets = [];
  }
  return json(200, {
    ok: true,
    data: {
      setup: setupManager.getState(),
      spec: stackManager.getSpec(),
      secrets: stackManager.listSecretManagerState(),
      catalog: stackManager.listStackCatalogItems(snippets),
      channels: stackManager.listChannelNames().map((name) => ({
        name,
        exposure: stackManager.getChannelAccess(name),
        config: stackManager.getChannelConfig(name)
      })),
      services: stackManager.listServiceNames().map((name) => ({
        name,
        config: stackManager.getServiceConfig(name)
      })),
      automations: stackManager.listAutomations()
    }
  });
};

export { GET };
//# sourceMappingURL=_server.ts-C4F519xC.js.map
