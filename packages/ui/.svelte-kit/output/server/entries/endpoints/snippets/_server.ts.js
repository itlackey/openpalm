import { u as unauthorizedJson, j as json } from "../../../chunks/json.js";
import { B as BUILTIN_CHANNELS } from "../../../chunks/index.js";
import { CORE_AUTOMATIONS } from "../../../chunks/index2.js";
import { d as discoverAllSnippets } from "../../../chunks/snippet-discovery.js";
import { l as log } from "../../../chunks/init.js";
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
export {
  GET
};
