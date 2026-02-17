import { copyFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseJsonc, stringifyPretty } from "./jsonc.ts";

const NPM_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

export function validatePluginIdentifier(id: string) {
  if (!id) return false;
  if (id.startsWith("./.opencode/plugins/")) return !/[\s;&|`$]/.test(id);
  return NPM_RE.test(id);
}

export function classifyPluginRisk(id: string): "low" | "high" | "critical" {
  if (id.startsWith("./.opencode/plugins/")) return "high";
  if (id.includes("security") || id.includes("exec") || id.includes("shell")) return "critical";
  return "high";
}

export async function preflightPlugin(pluginId: string): Promise<{ ok: boolean; details: string }> {
  if (pluginId.startsWith("./.opencode/plugins/")) return { ok: true, details: "local plugin path" };
  try {
    const resp = await fetch(`https://registry.npmjs.org/${pluginId}`);
    if (!resp.ok) return { ok: false, details: `registry status ${resp.status}` };
    return { ok: true, details: "package exists" };
  } catch {
    return { ok: false, details: "registry preflight unavailable" };
  }
}

export function updatePluginListAtomically(configPath: string, pluginId: string, enabled: boolean) {
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
  mkdirSync(dirname(configPath), { recursive: true });
  const temp = join(dirname(configPath), `.tmp-opencode-${Date.now()}.jsonc`);
  writeFileSync(temp, next, "utf8");
  renameSync(temp, configPath);
  return { backupPath, plugins };
}
