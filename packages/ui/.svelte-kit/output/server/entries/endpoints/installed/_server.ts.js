import { u as unauthorizedJson, j as json } from "../../../chunks/json.js";
import { r as readInstalledPlugins } from "../../../chunks/opencode-config.js";
const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const plugins = readInstalledPlugins();
  return json(200, { plugins });
};
export {
  GET
};
