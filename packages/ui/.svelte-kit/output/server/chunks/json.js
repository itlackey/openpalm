import { json as json$1 } from "@sveltejs/kit";
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
export {
  errorJson as e,
  json as j,
  unauthorizedJson as u
};
