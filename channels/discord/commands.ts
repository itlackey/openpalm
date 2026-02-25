/**
 * Slash command definitions for the Discord channel.
 *
 * Provides built-in commands (/ask, /health, /help, /clear) and supports
 * user-defined custom commands loaded from the DISCORD_CUSTOM_COMMANDS env var.
 * Custom commands map to prompt templates sent to the assistant.
 */

import type { CustomCommandDef, CustomCommandOption } from "./types.ts";
import { CommandOptionType } from "./types.ts";
import { createLogger } from "@openpalm/lib/shared/logger.ts";

const log = createLogger("channel-discord");

/* ── Built-in command definitions ──────────────────────────────────── */

export const BUILTIN_COMMANDS: CustomCommandDef[] = [
  {
    name: "ask",
    description: "Send a message to the assistant",
    options: [
      {
        name: "message",
        description: "Your message or question",
        type: CommandOptionType.STRING,
        required: true,
      },
    ],
  },
  {
    name: "health",
    description: "Check the assistant's health status",
    ephemeral: true,
  },
  {
    name: "help",
    description: "Show available commands and usage information",
    ephemeral: true,
  },
  {
    name: "clear",
    description: "Start a fresh conversation (clears session context)",
    ephemeral: true,
  },
];

/* ── Custom command loading ────────────────────────────────────────── */

const VALID_NAME = /^[\w-]{1,32}$/;
const MAX_DESCRIPTION_LENGTH = 100;
const MAX_CUSTOM_COMMANDS = 20;

function validateCommandOption(opt: unknown, cmdName: string): CustomCommandOption | null {
  if (!opt || typeof opt !== "object") return null;
  const o = opt as Record<string, unknown>;

  if (typeof o.name !== "string" || !VALID_NAME.test(o.name)) {
    log.warn("invalid_custom_command_option", { command: cmdName, option: o.name, reason: "invalid_name" });
    return null;
  }
  if (typeof o.description !== "string" || o.description.length > MAX_DESCRIPTION_LENGTH) {
    log.warn("invalid_custom_command_option", { command: cmdName, option: o.name, reason: "invalid_description" });
    return null;
  }

  const validTypes = new Set<number>(Object.values(CommandOptionType));
  const type = typeof o.type === "number" && validTypes.has(o.type) ? (o.type as typeof CommandOptionType[keyof typeof CommandOptionType]) : CommandOptionType.STRING;

  let choices: Array<{ name: string; value: string }> | undefined;
  if (Array.isArray(o.choices)) {
    choices = o.choices
      .filter(
        (c): c is { name: string; value: string } =>
          typeof c === "object" && c !== null && typeof c.name === "string" && typeof c.value === "string",
      )
      .slice(0, 25); // Discord max 25 choices
  }

  return {
    name: o.name,
    description: o.description,
    type,
    required: typeof o.required === "boolean" ? o.required : false,
    choices,
  };
}

/**
 * Parse custom commands from the DISCORD_CUSTOM_COMMANDS environment variable.
 * Expected format: JSON array of CustomCommandDef objects.
 *
 * Example:
 * ```json
 * [
 *   {
 *     "name": "summarize",
 *     "description": "Summarize a topic",
 *     "options": [{ "name": "topic", "description": "The topic", "type": 3, "required": true }],
 *     "promptTemplate": "Please summarize: {{topic}}"
 *   }
 * ]
 * ```
 */
export function parseCustomCommands(raw: string | undefined): CustomCommandDef[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.error("custom_commands_parse_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.error("custom_commands_invalid_format", { reason: "expected_array" });
    return [];
  }

  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  const commands: CustomCommandDef[] = [];

  for (const entry of parsed.slice(0, MAX_CUSTOM_COMMANDS)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    if (typeof e.name !== "string" || !VALID_NAME.test(e.name)) {
      log.warn("invalid_custom_command", { name: e.name, reason: "invalid_name" });
      continue;
    }

    if (builtinNames.has(e.name)) {
      log.warn("invalid_custom_command", { name: e.name, reason: "conflicts_with_builtin" });
      continue;
    }

    if (typeof e.description !== "string" || e.description.length === 0 || e.description.length > MAX_DESCRIPTION_LENGTH) {
      log.warn("invalid_custom_command", { name: e.name, reason: "invalid_description" });
      continue;
    }

    let options: CustomCommandOption[] | undefined;
    if (Array.isArray(e.options)) {
      options = e.options
        .map((o) => validateCommandOption(o, e.name as string))
        .filter((o): o is CustomCommandOption => o !== null);
    }

    commands.push({
      name: e.name,
      description: e.description,
      options,
      promptTemplate: typeof e.promptTemplate === "string" ? e.promptTemplate : undefined,
      ephemeral: typeof e.ephemeral === "boolean" ? e.ephemeral : false,
    });
  }

  if (commands.length > 0) {
    log.info("custom_commands_loaded", {
      count: commands.length,
      commands: commands.map((c) => c.name),
    });
  }

  return commands;
}

/**
 * Build the full command list (built-in + custom) and return the
 * Discord API-compatible payload for command registration.
 */
export function buildCommandRegistry(customCommands: CustomCommandDef[]): {
  all: CustomCommandDef[];
  registrationPayload: Array<{
    name: string;
    description: string;
    type: number;
    options?: Array<{
      name: string;
      description: string;
      type: number;
      required?: boolean;
      choices?: Array<{ name: string; value: string }>;
    }>;
  }>;
} {
  const all = [...BUILTIN_COMMANDS, ...customCommands];

  const registrationPayload = all.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    type: 1, // CHAT_INPUT
    ...(cmd.options?.length
      ? {
          options: cmd.options.map((opt) => ({
            name: opt.name,
            description: opt.description,
            type: opt.type,
            required: opt.required ?? false,
            ...(opt.choices?.length ? { choices: opt.choices } : {}),
          })),
        }
      : {}),
  }));

  return { all, registrationPayload };
}

/**
 * Resolve a prompt template by substituting {{optionName}} placeholders
 * with the values from the interaction options.
 */
export function resolvePromptTemplate(
  template: string,
  options: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => options[key] ?? "");
}

/**
 * Look up a command definition by name.
 */
export function findCommand(
  commands: CustomCommandDef[],
  name: string,
): CustomCommandDef | undefined {
  return commands.find((c) => c.name === name);
}
