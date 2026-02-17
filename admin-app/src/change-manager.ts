import { mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";

export type RiskTier = "low" | "medium" | "high" | "critical";

export function classifyBundleRisk(bundlePath: string): RiskTier {
  const files = readdirSync(bundlePath);
  if (files.includes("plugins")) return "critical";
  if (files.includes("tools")) return "high";
  if (files.includes("skills")) return "low";
  return "medium";
}

export function validateBundle(bundlePath: string) {
  const manifestPath = join(bundlePath, "manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, errors: ["manifest.json missing"] };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const errors: string[] = [];
  if (!manifest.id) errors.push("manifest.id missing");
  if (!manifest.version) errors.push("manifest.version missing");
  return { ok: errors.length === 0, errors };
}

export function snapshotFile(path: string) {
  const backup = `${path}.${Date.now()}.bak`;
  copyFileSync(path, backup);
  return backup;
}

export function prepareBundleRegistry(registryPath: string) {
  mkdirSync(join(registryPath), { recursive: true });
}

export function registerBundleState(registryPath: string, state: Record<string, unknown>) {
  const id = String(state.id ?? Date.now());
  const out = join(registryPath, `${id}.json`);
  writeFileSync(out, JSON.stringify(state, null, 2), "utf8");
  return basename(out);
}

export function collectBundleMetrics(bundlePath: string) {
  const entries = readdirSync(bundlePath).map((name) => {
    const full = join(bundlePath, name);
    const st = statSync(full);
    return { name, isDirectory: st.isDirectory(), size: st.size };
  });
  return { files: entries, risk: classifyBundleRisk(bundlePath) };
}
