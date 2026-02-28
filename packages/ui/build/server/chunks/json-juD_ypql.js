import { j as json$1 } from './index-CoD1IJuy.js';

function json(status, payload) {
  return json$1(payload, { status });
}
function errorJson(status, error, details) {
  const payload = { error };
  if (details !== void 0) payload.details = details;
  return json(status, payload);
}
function unauthorizedJson() {
  return json(401, { ok: false, error: "unauthorized", code: "admin_token_required" });
}

export { errorJson as e, json as j, unauthorizedJson as u };
//# sourceMappingURL=json-juD_ypql.js.map
