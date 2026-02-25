import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CRON_DIR = "/state/automations";
let _cronDir = DEFAULT_CRON_DIR;

/** Set the cron directory for history lookups. Call once at startup. */
export function configureCronDir(dir: string): void { _cronDir = dir; }

export type AutomationRun = {
  ts: string;
  id: string;
  status: "success" | "error" | "skipped";
  exit?: number;
  dur?: number;
  preview?: string;
  error?: string;
};

export function readHistory(id: string, limit = 20, cronDir = _cronDir): AutomationRun[] {
  const path = join(cronDir, "log", `${id}.jsonl`);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const runs: AutomationRun[] = [];
  for (let i = lines.length - 1; i >= 0 && runs.length < limit; i--) {
    try {
      runs.push(JSON.parse(lines[i]) as AutomationRun);
    } catch {
      // ignore malformed lines
    }
  }
  return runs;
}

export function getLatestRun(id: string, cronDir = _cronDir): AutomationRun | null {
  const runs = readHistory(id, 1, cronDir);
  return runs[0] ?? null;
}
