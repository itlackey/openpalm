import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { join } from "node:path";
import type { StackAutomation } from "@openpalm/lib/admin/stack-spec.ts";

const cronDir = Bun.env.CRON_DIR ?? "/app/cron";
const scriptsDir = join(cronDir, "scripts");
const logDir = join(cronDir, "log");
const lockDir = join(cronDir, "lock");
const runnerPath = join(cronDir, "run-automation");

function fileSafeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid_automation_id");
  return id;
}

export function ensureCronDirs(): void {
  for (const dir of [cronDir, scriptsDir, logDir, lockDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeRunner();
}

export function syncAutomations(automations: StackAutomation[]): void {
  ensureCronDirs();
  const activeIds = new Set<string>();

  for (const automation of automations) {
    const id = fileSafeId(automation.id);
    activeIds.add(id);
    const scriptPath = join(scriptsDir, `${id}.sh`);
    writeFileSync(scriptPath, automation.script, "utf8");
    chmodSync(scriptPath, 0o755);
  }

  for (const file of readdirSync(scriptsDir)) {
    if (!file.endsWith(".sh")) continue;
    const id = file.slice(0, -3);
    if (!activeIds.has(id)) rmSync(join(scriptsDir, file), { force: true });
  }

  const lines = ["# OpenPalm automations — managed by admin, do not edit", ""];
  for (const automation of automations) {
    const id = fileSafeId(automation.id);
    const prefix = automation.enabled ? "" : "# DISABLED: ";
    lines.push(`# ${automation.name} (${id})`);
    lines.push(`${prefix}${automation.schedule} ${runnerPath} ${id}`);
    lines.push("");
  }

  const crontabPath = join(cronDir, "crontab");
  writeFileSync(crontabPath, lines.join("\n"), "utf8");

  try {
    execSync(`crontab ${crontabPath}`, { stdio: "pipe" });
  } catch (error) {
    console.error("crontab reload failed", error);
  }
}

export function triggerAutomation(idRaw: string): Promise<{ ok: boolean; error?: string }> {
  const id = fileSafeId(idRaw);
  return new Promise((resolve) => {
    const proc = spawn(runnerPath, [id], { stdio: "pipe" });
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

function writeRunner(): void {
  const script = `#!/usr/bin/env bash
set -uo pipefail

ID="\${1:?automation ID required}"
SCRIPT="${scriptsDir}/\${ID}.sh"
LOG_FILE="${logDir}/\${ID}.jsonl"
LOCK_FILE="${lockDir}/\${ID}.lock"

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

  writeFileSync(runnerPath, script, "utf8");
  chmodSync(runnerPath, 0o755);
}
