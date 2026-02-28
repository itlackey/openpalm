import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { a as getStackManager } from './init-C6nnJEAN.js';
import { readHistory } from './automation-history-CctHM2Up.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';

const GET = async ({ locals, url }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const id = (url.searchParams.get("id") ?? "").trim();
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 20;
  if (!id) return json(400, { error: "id is required" });
  const stackManager = await getStackManager();
  if (!stackManager.getAutomation(id)) return json(404, { error: "automation not found" });
  return json(200, { id, logs: readHistory(id, limit) });
};

export { GET };
//# sourceMappingURL=_server.ts-Bu4YLfAY.js.map
