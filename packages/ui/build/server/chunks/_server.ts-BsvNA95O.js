import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { composePs } from './compose-runner-BT0hCcoV.js';
import './index-CoD1IJuy.js';

const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const result = await composePs();
  if (!result.ok) return json(500, { ok: false, error: result.stderr });
  return json(200, { ok: true, services: result.services });
};

export { GET };
//# sourceMappingURL=_server.ts-BsvNA95O.js.map
