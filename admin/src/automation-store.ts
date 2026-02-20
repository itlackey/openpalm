import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { JsonStore } from "./admin-store.ts";

export type Automation = {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  status: "enabled" | "disabled";
  createdAt: string;
};

export type AutomationState = {
  automations: Automation[];
};

/**
 * Manages automation metadata (automations.json) and generates the crontab + payload
 * files that the opencode-core container's system cron daemon executes.
 *
 * Layout on the shared config volume:
 *   <crontabDir>/crontab              — installed by entrypoint.sh from /cron/crontab
 *   <crontabDir>/cron-payloads/<id>.json — curl reads these with -d @<file>
 */
export class AutomationStore {
  private store: JsonStore<AutomationState>;
  private crontabDir: string;
  private payloadDir: string;

  constructor(dataDir: string, crontabDir: string) {
    this.store = new JsonStore<AutomationState>(`${dataDir}/automations.json`, { automations: [] });
    this.crontabDir = crontabDir;
    this.payloadDir = `${crontabDir}/cron-payloads`;
    mkdirSync(this.payloadDir, { recursive: true });
    // Sync crontab on startup so it matches persisted state
    this.writeCrontab();
  }

  list(): Automation[] {
    return this.store.get().automations;
  }

  get(id: string): Automation | undefined {
    return this.store.get().automations.find((j) => j.id === id);
  }

  add(automation: Automation): void {
    const state = this.store.get();
    state.automations.push(automation);
    this.store.set(state);
  }

  update(id: string, fields: Partial<Omit<Automation, "id" | "createdAt">>): Automation | undefined {
    const state = this.store.get();
    const idx = state.automations.findIndex((j) => j.id === id);
    if (idx === -1) return undefined;
    state.automations[idx] = { ...state.automations[idx], ...fields };
    this.store.set(state);
    return state.automations[idx];
  }

  remove(id: string): boolean {
    const state = this.store.get();
    const before = state.automations.length;
    state.automations = state.automations.filter((j) => j.id !== id);
    if (state.automations.length === before) return false;
    this.store.set(state);
    // Clean up the payload file
    const payloadPath = `${this.payloadDir}/${id}.json`;
    if (existsSync(payloadPath)) rmSync(payloadPath);
    return true;
  }

  /**
   * Regenerates the crontab file and per-automation JSON payloads from current state.
   * Call this after any mutation, then restart opencode-core so crond picks it up.
   */
  writeCrontab(): void {
    const automations = this.store.get().automations;
    const lines: string[] = [
      "# OpenPalm automations — managed by admin, do not edit manually",
      "# Installed into opencode-core container by entrypoint.sh",
      "",
    ];

    for (const job of automations) {
      // Write the JSON payload file (avoids shell-escaping issues)
      const payload = JSON.stringify({
        message: job.prompt,
        session_id: `cron-${job.id}`,
        user_id: "cron-scheduler",
        metadata: { source: "automation", automationId: job.id, automationName: job.name },
      });
      writeFileSync(`${this.payloadDir}/${job.id}.json`, payload);

      // Add crontab entry (commented out if disabled)
      const prefix = job.status === "enabled" ? "" : "# DISABLED: ";
      // Sanitize name to prevent crontab injection via newlines
      const safeName = job.name.replace(/[\r\n]/g, " ");
      lines.push(`# ${safeName} (${job.id})`);
      lines.push(
        `${prefix}${job.schedule} curl -sf -m 120 -X POST http://localhost:4096/chat -H 'Content-Type: application/json' -d @/cron/cron-payloads/${job.id}.json >/dev/null 2>&1`
      );
      lines.push("");
    }

    writeFileSync(`${this.crontabDir}/crontab`, lines.join("\n"));
  }
}

// Validates a single cron field value against a min/max range.
function validateCronField(field: string, min: number, max: number, label: string): string | null {
  for (const part of field.split(",")) {
    if (!part) return `empty value in ${label} field`;
    const [base, stepStr] = part.split("/");
    if (stepStr !== undefined) {
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step < 1) return `invalid step "${stepStr}" in ${label} field`;
    }
    if (base === "*") continue;
    if (base.includes("-")) {
      const [lo, hi] = base.split("-");
      const loN = parseInt(lo, 10);
      const hiN = parseInt(hi, 10);
      if (isNaN(loN) || isNaN(hiN)) return `invalid range "${base}" in ${label} field`;
      if (loN < min || loN > max) return `${label} value ${loN} out of range ${min}-${max}`;
      if (hiN < min || hiN > max) return `${label} value ${hiN} out of range ${min}-${max}`;
      if (loN > hiN) return `invalid range ${loN}-${hiN} in ${label} field`;
      continue;
    }
    const n = parseInt(base, 10);
    if (isNaN(n)) return `invalid value "${base}" in ${label} field`;
    if (n < min || n > max) return `${label} value ${n} out of range ${min}-${max}`;
  }
  return null;
}

/**
 * Validates a 5-field cron expression with numeric range checking.
 * Returns null if valid, or an error message string.
 */
export function validateCron(expr: string): string | null {
  if (!expr || !expr.trim()) return "cron expression is required";
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "cron expression must have exactly 5 fields";
  const fieldPattern = /^[\d*\/\-,]+$/;
  const labels = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  for (let i = 0; i < 5; i++) {
    if (!fieldPattern.test(parts[i])) {
      return `invalid characters in ${labels[i]} field: "${parts[i]}"`;
    }
    const rangeErr = validateCronField(parts[i], ranges[i][0], ranges[i][1], labels[i]);
    if (rangeErr) return rangeErr;
  }
  return null;
}
