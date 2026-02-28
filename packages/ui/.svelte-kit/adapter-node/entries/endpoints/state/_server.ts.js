import { u as unauthorizedJson, j as json } from "../../../chunks/json.js";
import { a as getSetupManager, g as getStackManager, l as log } from "../../../chunks/init.js";
import { d as discoverAllSnippets } from "../../../chunks/snippet-discovery.js";
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
export {
  GET
};
