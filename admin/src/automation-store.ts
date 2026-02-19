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
      lines.push(`# ${job.name} (${job.id})`);
      lines.push(
        `${prefix}${job.schedule} curl -sf -m 120 -X POST http://localhost:4096/chat -H 'Content-Type: application/json' -d @/cron/cron-payloads/${job.id}.json >/dev/null 2>&1`
      );
      lines.push("");
    }

    writeFileSync(`${this.crontabDir}/crontab`, lines.join("\n"));
  }
}

/**
 * Basic validation for 5-field cron expressions.
 * Returns null if valid, or an error message string.
 */
export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "cron expression must have exactly 5 fields";
  // Validate each field allows only cron-legal characters: digits, *, /, -, ,
  const fieldPattern = /^[\d*\/\-,]+$/;
  const labels = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  for (let i = 0; i < 5; i++) {
    if (!fieldPattern.test(parts[i])) {
      return `invalid characters in ${labels[i]} field: "${parts[i]}"`;
    }
  }
  return null;
}
