import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { r as readInstalledPlugins } from './opencode-config-CEineNbb.js';
import './index-CoD1IJuy.js';
import 'node:fs';
import 'node:path';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';

const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const plugins = readInstalledPlugins();
  return json(200, { plugins });
};

export { GET };
//# sourceMappingURL=_server.ts-B29JkwMk.js.map
