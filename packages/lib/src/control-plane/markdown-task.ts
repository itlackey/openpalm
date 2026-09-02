/**
 * AKM task parser — the read side of knowledge/tasks/*.yml.
 *
 * akm 0.9.7's only standing grammar is task source v4 (`version: 4`), which is
 * what OpenPalm ships and what the Automations tab writes. Its targets:
 *   run:   <shell string> (+ optional `shell:`) — a host command
 *   uses:  akm/command (+ `with.content`)      — a prompt for the assistant
 *   uses:  workflows/<name>                    — a workflow
 *   uses:  commands/<name> | scripts/<name>    — an akm asset, run as a command
 * and `schedule:` is either a cron string, a list of `{cron, enabled}` entries,
 * or absent entirely (manual-only — valid in v4, D2-N6).
 *
 * v2/v3 documents are still READ here because akm still reads them: its version
 * router converts them in memory through the same planners `akm migrate apply`
 * uses and warns, rather than rejecting. So an operator's own pre-v4 task is
 * live on the box and has to stay visible in the tab. Their shape:
 *   command  — `command: [...]` YAML array (argv) or shell string
 *   prompt   — `prompt: <text>` inline prompt text (+ optional `engine`)
 *   workflow — `workflow: <ref>` (conceptId, e.g. workflows/foo) + `params`
 * Nothing WRITES that shape anymore; see the task drawer's `formDataToYaml`.
 */
import { parse as parseYaml } from "yaml";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AutomationConfig } from "./scheduler.js";
import { createLogger } from "../logger.js";

const logger = createLogger("task-file");

// ── Types ─────────────────────────────────────────────────────────────────

export interface MarkdownTask {
  id: string;
  schedule: string;
  enabled: boolean;
  description?: string;
  tags?: string[];
  timeoutMs?: number;
  target: MarkdownTaskTarget;
  source: { path: string };
}

export type MarkdownTaskTarget =
  | { kind: "command"; cmd: string[] }
  | { kind: "prompt"; engine?: string; body: string }
  | { kind: "workflow"; ref: string; params: Record<string, unknown> };

/** The one task source version akm 0.9.7 accepts without a conversion shim. */
export const TASK_SOURCE_V4_VERSION = 4;

// ── Parser: task source v4 ────────────────────────────────────────────────

/**
 * The cron this task shows in the tab, and whether it is on.
 *
 * v4 has no top-level `enabled:` — it is a per-entry key inside `schedule:`,
 * which is why a disabled task has to use the list form at all. A task may
 * carry several entries; the tab renders one row per task, so the first is the
 * one it shows. Absent `schedule:` is legal and means manual-only: still
 * installed, still runnable from the tab, just not on a timer.
 */
function firstScheduleBinding(value: unknown): { cron: string; enabled: boolean } | null {
  if (typeof value === "string") {
    return value.trim() ? { cron: value.trim(), enabled: true } : null;
  }
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { cron, enabled } = entry as Record<string, unknown>;
    if (typeof cron !== "string" || !cron.trim()) continue;
    return { cron: cron.trim(), enabled: enabled !== false };
  }
  return null;
}

/** Map a v4 `uses:` ref onto the three targets this UI knows how to render. */
function usesTarget(ref: string, fm: Record<string, unknown>): MarkdownTaskTarget | null {
  if (ref === "akm/command") {
    const withBlock = fm.with;
    const content =
      withBlock && typeof withBlock === "object" && !Array.isArray(withBlock)
        ? (withBlock as Record<string, unknown>).content
        : undefined;
    if (typeof content !== "string" || !content.trim()) return null;
    return { kind: "prompt", engine: typeof fm.engine === "string" ? fm.engine : undefined, body: content.trim() };
  }
  // Always empty: `with:` is legal only on `uses: akm/command`, and a v4
  // workflow's arguments are typed `inputs:` bound per schedule entry. Nothing
  // downstream reads `params` — the tab renders the target kind, not its
  // arguments — so there is no reason to reach for them here.
  if (ref.startsWith("workflows/")) return { kind: "workflow", ref, params: {} };
  // commands/<name> and scripts/<name>: an akm asset invoked as a command.
  return { kind: "command", cmd: [ref] };
}

function parseTaskSourceV4(
  id: string,
  fm: Record<string, unknown>,
  filePath: string,
): MarkdownTask | null {
  let target: MarkdownTaskTarget | null;
  if (typeof fm.run === "string" && fm.run.trim()) {
    // `run:` is a shell string, not argv — akm hands it to `shell:` (default
    // sh). Keeping the shell explicit here is what stops a later writer from
    // re-splitting it on spaces and changing what it means.
    target = { kind: "command", cmd: [typeof fm.shell === "string" ? fm.shell : "sh", "-c", fm.run.trim()] };
  } else if (typeof fm.uses === "string" && fm.uses.trim()) {
    target = usesTarget(fm.uses.trim(), fm);
    if (!target) {
      logger.warn("task 'uses: akm/command' needs a non-empty with.content", { filePath });
      return null;
    }
  } else {
    logger.warn("task must have one of: run, uses", { filePath });
    return null;
  }

  const binding = firstScheduleBinding(fm.schedule);

  return {
    id,
    schedule: binding?.cron ?? "",
    enabled: binding?.enabled ?? true,
    description: typeof fm.description === "string" ? fm.description : undefined,
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : undefined,
    // v2's `timeoutMs:` is v4's `timeout:`, still milliseconds. v4 also accepts
    // a duration string ("30s"); nothing here consumes the number, so leave a
    // spelling we would have to guess at undefined rather than mis-scale it.
    timeoutMs: typeof fm.timeout === "number" ? fm.timeout : undefined,
    target,
    source: { path: filePath },
  };
}

// ── Parser ────────────────────────────────────────────────────────────────

function parseMarkdownTask(filePath: string): MarkdownTask | null {
  const fileName = basename(filePath);
  const id = fileName.replace(/\.(?:ya?ml|md)$/, "");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    logger.warn("failed to read task file", { filePath, error: String(err) });
    return null;
  }

  const { frontmatter, body } = splitTaskSource(raw);
  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(frontmatter);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn("task YAML is not an object", { filePath });
      return null;
    }
    fm = parsed as Record<string, unknown>;
  } catch (err) {
    logger.warn("failed to parse task YAML", { filePath, error: String(err) });
    return null;
  }

  if (fm.version === TASK_SOURCE_V4_VERSION) return parseTaskSourceV4(id, fm, filePath);

  const schedule = fm.schedule;
  if (typeof schedule !== "string" || !schedule.trim()) {
    logger.warn("task missing or empty 'schedule'", { filePath });
    return null;
  }

  // Resolve target type from frontmatter
  let target: MarkdownTaskTarget;

  if (fm.command !== undefined) {
    const cmd = Array.isArray(fm.command)
      ? fm.command.map(String)
      : typeof fm.command === "string"
        ? [fm.command]
        : null;
    if (!cmd || cmd.length === 0) {
      logger.warn("task 'command' must be a non-empty array", { filePath });
      return null;
    }
    target = { kind: "command", cmd };
  } else if (fm.prompt !== undefined) {
    if (typeof fm.prompt !== "string" || !fm.prompt.trim()) {
      logger.warn("task 'prompt' must be a non-empty string", { filePath });
      return null;
    }
    const promptBody = fm.prompt.trim() === "inline" ? body.trim() : fm.prompt.trim();
    if (!promptBody) {
      logger.warn("task prompt body is empty", { filePath });
      return null;
    }
    target = {
      kind: "prompt",
      // akm task YAML v2 spells the dispatch selection `engine`; accept the
      // retired 0.8 `profile` spelling as a read-only fallback so pre-upgrade
      // files still render in the UI until `akm migrate apply` rewrites them.
      engine:
        typeof fm.engine === "string"
          ? fm.engine
          : typeof fm.profile === "string"
            ? fm.profile
            : undefined,
      body: promptBody,
    };
  } else if (fm.workflow !== undefined) {
    if (typeof fm.workflow !== "string") {
      logger.warn("task 'workflow' must be a string ref", { filePath });
      return null;
    }
    target = {
      kind: "workflow",
      ref: fm.workflow,
      params: (fm.params && typeof fm.params === "object" && !Array.isArray(fm.params))
        ? fm.params as Record<string, unknown>
        : {},
    };
  } else {
    logger.warn("task must have one of: command, prompt, workflow", { filePath });
    return null;
  }

  return {
    id,
    schedule: schedule.trim(),
    enabled: fm.enabled !== false,
    description: typeof fm.description === "string" ? fm.description : undefined,
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : undefined,
    timeoutMs: typeof fm.timeoutMs === "number" ? fm.timeoutMs : undefined,
    target,
    source: { path: filePath },
  };
}

function splitTaskSource(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: raw, body: "" };
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

export function loadMarkdownTasks(stashDir: string): MarkdownTask[] {
  const dir = join(stashDir, "tasks");
  if (!existsSync(dir)) return [];

  const tasks: MarkdownTask[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || (!entry.name.endsWith(".md") && !entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml"))) continue;
    const task = parseMarkdownTask(join(dir, entry.name));
    if (task) tasks.push(task);
  }
  return tasks;
}

// ── AutomationConfig adapter ──────────────────────────────────────────────
// Keeps the GET /api/host/automations response shape compatible so the existing
// UI does not require changes.

export function taskToAutomationConfig(task: MarkdownTask): AutomationConfig {
  const { target } = task;

  let actionType: "shell" | "assistant" | "workflow" | "api" | "http";
  let content: string | undefined;
  let agent: string | undefined;

  if (target.kind === "command") {
    actionType = "shell";
  } else if (target.kind === "prompt") {
    actionType = "assistant";
    content = target.body;
    agent = target.engine;
  } else {
    actionType = "workflow";
  }

  return {
    name: task.id,
    description: task.description ?? "",
    schedule: task.schedule,
    timezone: "",
    enabled: task.enabled,
    action: {
      type: actionType,
      content,
      agent,
    },
    on_failure: "log",
    fileName: basename(task.source.path),
  };
}
