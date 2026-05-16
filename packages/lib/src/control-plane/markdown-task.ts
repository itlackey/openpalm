/**
 * AKM markdown task parser.
 *
 * Task files are markdown with YAML frontmatter. The frontmatter defines the
 * schedule and target; for inline-prompt tasks the markdown body is the prompt.
 *
 * Supported target types:
 *   command  — `command: [...]` YAML array (argv), run via Bun.spawn / akm tasks run
 *   prompt   — `prompt: inline` + markdown body as the prompt text
 *   workflow — `workflow: workflow:<ref>` + optional `params` map
 */
import { parse as parseYaml } from "yaml";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AutomationConfig } from "./scheduler.js";
import { createLogger } from "../logger.js";

const logger = createLogger("markdown-task");

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

// ── Frontmatter splitter ──────────────────────────────────────────────────

interface ParsedFile {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(content: string): ParsedFile | null {
  // Must start with ---
  if (!content.startsWith("---")) return null;
  const after = content.slice(3);
  const end = after.indexOf("\n---");
  if (end === -1) return null;
  return {
    frontmatter: after.slice(0, end).trim(),
    body: after.slice(end + 4).trim(),
  };
}

// ── Parser ────────────────────────────────────────────────────────────────

export function parseMarkdownTask(filePath: string): MarkdownTask | null {
  const id = filePath.replace(/.*[\\/]/, "").replace(/\.md$/, "");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    logger.warn("failed to read task file", { filePath, error: String(err) });
    return null;
  }

  const parts = splitFrontmatter(raw);
  if (!parts) {
    logger.warn("task file missing frontmatter delimiters", { filePath });
    return null;
  }

  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(parts.frontmatter) as Record<string, unknown>;
  } catch (err) {
    logger.warn("failed to parse task frontmatter", { filePath, error: String(err) });
    return null;
  }

  if (!fm || typeof fm !== "object") {
    logger.warn("task frontmatter is not an object", { filePath });
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
    if (fm.prompt !== "inline") {
      // Future: handle asset-ref and file-path prompt sources
      logger.warn("task 'prompt' supports only 'inline' currently", { filePath });
      return null;
    }
    if (!parts.body) {
      logger.warn("prompt:inline task has no markdown body", { filePath });
      return null;
    }
    target = {
      kind: "prompt",
      profile: typeof fm.profile === "string" ? fm.profile : undefined,
      body: parts.body,
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

export function loadMarkdownTasks(stashDir: string): MarkdownTask[] {
  const dir = join(stashDir, "tasks");
  if (!existsSync(dir)) return [];

  const tasks: MarkdownTask[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
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
    fileName: `${task.id}.md`,
  };
}
