import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseJsonc, stringifyPretty } from "./jsonc.ts";

const NPM_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

function ensureConfigFile(configPath: string) {
  mkdirSync(dirname(configPath), { recursive: true });
  if (!existsSync(configPath)) writeFileSync(configPath, "{}\n", "utf8");
}

export function validatePluginIdentifier(id: string) {
  if (!id) return false;
  if (id.startsWith("./plugins/")) return !/[\s;&|`$]/.test(id);
  return NPM_RE.test(id);
}

export function updatePluginListAtomically(configPath: string, pluginId: string, enabled: boolean) {
  ensureConfigFile(configPath);
  const raw = readFileSync(configPath, "utf8");
  const doc = parseJsonc(raw) as { plugin?: string[] };
  const plugins = Array.isArray(doc.plugin) ? [...doc.plugin] : [];

  if (enabled && !plugins.includes(pluginId)) plugins.push(pluginId);
  if (!enabled) {
    const idx = plugins.indexOf(pluginId);
    if (idx >= 0) plugins.splice(idx, 1);
  }

  const next = stringifyPretty({ ...doc, plugin: plugins });
  const backupPath = `${configPath}.${Date.now()}.bak`;
  copyFileSync(configPath, backupPath);
  const temp = join(dirname(configPath), `.tmp-opencode-${Date.now()}.jsonc`);
  writeFileSync(temp, next, "utf8");
  renameSync(temp, configPath);
  return { backupPath, plugins };
}
