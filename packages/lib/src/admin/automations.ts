import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { join } from "node:path";
import type { StackAutomation } from "./stack-spec.ts";
import { validateCron } from "./cron.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("admin");

const DEFAULT_CRON_DIR = "/state/automations";
let _cronDir = DEFAULT_CRON_DIR;

/** Set the cron directory for all automations operations. Call once at startup. */
export function configureCronDir(dir: string): void { _cronDir = dir; }

function scriptsDir(base: string): string { return join(base, "scripts"); }
function logDir(base: string): string { return join(base, "log"); }
function lockDir(base: string): string { return join(base, "lock"); }
function cronEnabledDir(base: string): string { return join(base, "cron.d.enabled"); }
function cronDisabledDir(base: string): string { return join(base, "cron.d.disabled"); }
function combinedSchedulePath(base: string): string { return join(base, "cron.schedule"); }
function runnerPath(base: string): string { return join(base, "run-automation"); }

function fileSafeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid_automation_id");
  return id;
}

function sortedFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
}

function clearCronEntries(dir: string): void {
  for (const file of sortedFiles(dir)) {
    rmSync(join(dir, file), { force: true });
  }
}

export function ensureCronDirs(cronDir = _cronDir): void {
  for (const dir of [cronDir, scriptsDir(cronDir), logDir(cronDir), lockDir(cronDir), cronEnabledDir(cronDir), cronDisabledDir(cronDir)]) {
    mkdirSync(dir, { recursive: true });
  }
  writeRunner(cronDir);
}

export function syncAutomations(automations: StackAutomation[], cronDir = _cronDir): void {
  ensureCronDirs(cronDir);
  const activeIds = new Set<string>();

  for (const automation of automations) {
    const cronError = validateCron(automation.schedule);
    if (cronError) throw new Error("invalid_cron_schedule");
    const id = fileSafeId(automation.id);
    activeIds.add(id);
    const scriptPath = join(scriptsDir(cronDir), `${id}.sh`);
    writeFileSync(scriptPath, automation.script, "utf8");
    chmodSync(scriptPath, 0o755);
  }

  for (const file of readdirSync(scriptsDir(cronDir))) {
    if (!file.endsWith(".sh")) continue;
    const id = file.slice(0, -3);
    if (!activeIds.has(id)) rmSync(join(scriptsDir(cronDir), file), { force: true });
  }

  clearCronEntries(cronEnabledDir(cronDir));
  clearCronEntries(cronDisabledDir(cronDir));

  const combinedLines = ["# OpenPalm automations — managed by admin, do not edit", ""];
  const sortedAutomations = [...automations].sort((a, b) => a.id.localeCompare(b.id));

  for (const [index, automation] of sortedAutomations.entries()) {
    const id = fileSafeId(automation.id);
    const fileName = `${String(index + 1).padStart(2, "0")}-${id}`;
    const entry = [
      "# OpenPalm automation (managed)",
      `# ${automation.name} (${id})`,
      `${automation.schedule} ${runnerPath(cronDir)} ${id}`,
      "",
    ].join("\n");

    if (automation.enabled) {
      writeFileSync(join(cronEnabledDir(cronDir), fileName), entry, "utf8");
      combinedLines.push(`# ${automation.name} (${id})`);
      combinedLines.push(`${automation.schedule} ${runnerPath(cronDir)} ${id}`);
      combinedLines.push("");
    } else {
      writeFileSync(join(cronDisabledDir(cronDir), fileName), entry, "utf8");
    }
  }

  writeFileSync(combinedSchedulePath(cronDir), `${combinedLines.join("\n")}`.trimEnd() + "\n", "utf8");

  try {
    execSync(`crontab ${combinedSchedulePath(cronDir)}`, { stdio: "pipe" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("crontab: not found")) {
      log.warn("crontab reload skipped: binary not available in this environment");
      return;
    }
    log.error("crontab reload failed", { error: message });
  }
}

export function triggerAutomation(idRaw: string, cronDir = _cronDir): Promise<{ ok: boolean; error?: string }> {
  const id = fileSafeId(idRaw);
  return new Promise((resolve) => {
    const proc = spawn(runnerPath(cronDir), [id], { stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("close", (code) => {
      if (code === 0) return resolve({ ok: true });
      return resolve({ ok: false, error: stderr.slice(0, 200) || "automation_failed" });
    });
    proc.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
  });
}

function writeRunner(cronDir: string): void {
  const script = `#!/usr/bin/env bash
set -uo pipefail

ID="\${1:?automation ID required}"
SCRIPT="${scriptsDir(cronDir)}/\${ID}.sh"
LOG_FILE="${logDir(cronDir)}/\${ID}.jsonl"
LOCK_FILE="${lockDir(cronDir)}/\${ID}.lock"

if [[ ! -f "$SCRIPT" ]]; then
  printf '{"ts":"%s","id":"%s","status":"error","error":"script_not_found"}\\n' \\
    "$(date -Iseconds)" "$ID" >> "$LOG_FILE"
  exit 1
fi

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  printf '{"ts":"%s","id":"%s","status":"skipped","error":"previous_run_active"}\\n' \\
    "$(date -Iseconds)" "$ID" >> "$LOG_FILE"
  exit 0
fi

START=$(date +%s%N)
set +e
OUTPUT=$(bash "$SCRIPT" 2>&1)
EXIT_CODE=$?
set -e
DURATION_MS=$(( ( $(date +%s%N) - START ) / 1000000 ))
PREVIEW=$(printf '%s' "$OUTPUT" | head -c 200 | tr '\\n"\\\\' '  _')

if [[ $EXIT_CODE -eq 0 ]]; then STATUS="success"; else STATUS="error"; fi

printf '{"ts":"%s","id":"%s","status":"%s","exit":%d,"dur":%d,"preview":"%s"}\\n' \\
  "$(date -Iseconds)" "$ID" "$STATUS" "$EXIT_CODE" "$DURATION_MS" "$PREVIEW" \\
  >> "$LOG_FILE"
`;

  writeFileSync(runnerPath(cronDir), script, "utf8");
  chmodSync(runnerPath(cronDir), 0o755);
}
