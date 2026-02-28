import { j as json } from "../../../chunks/json.js";
const GET = async () => {
  return json(200, { ok: true, service: "admin", time: (/* @__PURE__ */ new Date()).toISOString() });
};
export {
  GET
};
