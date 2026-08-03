/**
 * Legacy AKM task parser retained as unexported source because deleting the
 * file was not approved. Production task handling must delegate semantics to
 * AKM and must not import this module.
 *
 * Task files are YAML documents in knowledge/tasks/. Supported target types:
 *   command  — `command: [...]` YAML array (argv)
 *   prompt   — `prompt: <text>` inline prompt text
 *   workflow — `workflow: workflow:<ref>` + optional `params` map
 */
import { parse as parseYaml } from "yaml";
import { basename, join } from "node:path";
import { createLogger } from "../logger.js";
import { listTaskFiles, readTaskFile } from "./task-files.js";

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
  | { kind: "prompt"; body: string }
  | { kind: "workflow"; ref: string; params: Record<string, unknown> };

// ── Parser ────────────────────────────────────────────────────────────────

function parseMarkdownTask(filePath: string, raw: string): MarkdownTask | null {
  const fileName = basename(filePath);
  const id = fileName.replace(/\.yml$/, "");

  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn("task YAML is not an object", { filePath });
      return null;
    }
    fm = parsed as Record<string, unknown>;
  } catch (err) {
    logger.warn("failed to parse task YAML", { filePath, error: String(err) });
    return null;
  }

  if (fm.version !== 2) {
    logger.warn("task version must be 2", { filePath });
    return null;
  }

  const schedule = fm.schedule;
  if (typeof schedule !== "string" || !schedule.trim()) {
    logger.warn("task missing or empty 'schedule'", { filePath });
    return null;
  }

  const targetKeys = ["command", "prompt", "workflow"].filter((key) => fm[key] !== undefined);
  if (targetKeys.length !== 1) {
    logger.warn("task must have exactly one of: command, prompt, workflow", { filePath });
    return null;
  }

  let target: MarkdownTaskTarget;

  if (fm.command !== undefined) {
    const cmd = Array.isArray(fm.command)
      && fm.command.length > 0
      && fm.command.every((part): part is string => typeof part === "string" && part.length > 0)
      ? fm.command
      : typeof fm.command === "string" && fm.command.trim() !== ""
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
    target = {
      kind: "prompt",
      body: fm.prompt.trim(),
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

export function loadMarkdownTasks(stashDir: string): MarkdownTask[] {
  const dir = join(stashDir, "tasks");
  const tasks: MarkdownTask[] = [];
  for (const file of listTaskFiles(stashDir)) {
    const raw = readTaskFile(stashDir, file.name);
    if (raw === null) continue;
    const task = parseMarkdownTask(join(dir, file.name), raw);
    if (task) tasks.push(task);
  }
  return tasks;
}
