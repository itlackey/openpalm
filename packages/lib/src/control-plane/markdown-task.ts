/**
 * AKM task parser.
 *
 * Task files are YAML documents in stash/tasks/. Supported target types:
 *   command  — `command: [...]` YAML array (argv)
 *   prompt   — `prompt: <text>` inline prompt text
 *   workflow — `workflow: workflow:<ref>` + optional `params` map
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
  | { kind: "prompt"; profile?: string; body: string }
  | { kind: "workflow"; ref: string; params: Record<string, unknown> };

// ── Parser ────────────────────────────────────────────────────────────────

export function parseMarkdownTask(filePath: string): MarkdownTask | null {
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
      profile: typeof fm.profile === "string" ? fm.profile : undefined,
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
// Keeps the GET /admin/automations response shape compatible so the existing
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
    agent = target.profile;
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
