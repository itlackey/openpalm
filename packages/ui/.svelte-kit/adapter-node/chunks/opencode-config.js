import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { b as OPENCODE_CONFIG_PATH } from "./config.js";
function parseJsonc(input) {
  const stripped = input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped);
}
function stringifyPretty(value) {
  return JSON.stringify(value, null, 2) + "\n";
}
function ensureOpencodeConfigPath() {
  if (existsSync(OPENCODE_CONFIG_PATH)) return;
  mkdirSync(dirname(OPENCODE_CONFIG_PATH), { recursive: true });
  writeFileSync(OPENCODE_CONFIG_PATH, '{\n  "plugin": []\n}\n', "utf8");
}
function applySmallModelToOpencodeConfig(endpoint, modelId) {
  if (!modelId || !existsSync(OPENCODE_CONFIG_PATH)) return;
  const raw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
  const doc = parseJsonc(raw);
  doc.small_model = modelId;
  if (endpoint) {
    const parts = modelId.split("/");
    const providerId = parts.length > 1 ? parts[0] : "openpalm-small";
    const providers = typeof doc.provider === "object" && doc.provider !== null ? { ...doc.provider } : {};
    const providerOptions = { baseURL: endpoint };
    providerOptions.apiKey = "{env:OPENPALM_SMALL_MODEL_API_KEY}";
    providers[providerId] = { options: providerOptions };
    doc.provider = providers;
  }
  writeFileSync(OPENCODE_CONFIG_PATH, stringifyPretty(doc), "utf8");
}
function readInstalledPlugins() {
  ensureOpencodeConfigPath();
  const raw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
  const doc = parseJsonc(raw);
  return Array.isArray(doc.plugin) ? doc.plugin.filter((value) => typeof value === "string") : [];
}
export {
  applySmallModelToOpencodeConfig as a,
  readInstalledPlugins as r
};
