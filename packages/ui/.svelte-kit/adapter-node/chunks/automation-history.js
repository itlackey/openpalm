import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const DEFAULT_CRON_DIR = "/state/automations";
let _cronDir = DEFAULT_CRON_DIR;
function configureCronDir(dir) {
  _cronDir = dir;
}
function readHistory(id, limit = 20, cronDir = _cronDir) {
  const path = join(cronDir, "log", `${id}.jsonl`);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const runs = [];
  for (let i = lines.length - 1; i >= 0 && runs.length < limit; i--) {
    try {
      runs.push(JSON.parse(lines[i]));
    } catch {
    }
  }
  return runs;
}
function getLatestRun(id, cronDir = _cronDir) {
  const runs = readHistory(id, 1, cronDir);
  return runs[0] ?? null;
}
export {
  configureCronDir,
  getLatestRun,
  readHistory
};
