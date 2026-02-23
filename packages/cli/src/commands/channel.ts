import { readFile } from "node:fs/promises";
import { error, info } from "@openpalm/lib/ui.ts";
import { executeAdminCommand } from "./admin.ts";

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function positionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    if (value.startsWith("--")) {
      const flag = value.slice(2);
      if (flag === "yaml" || flag === "file" || flag === "exposure" || flag === "config") {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    positional.push(value);
    index += 1;
  }
  return positional;
}

async function readYaml(args: string[]): Promise<string> {
  const positional = positionalArgs(args)[0];
  if (positional) {
    try {
      return await readFile(positional, "utf8");
    } catch {
      return positional;
    }
  }
  const yaml = getArg(args, "yaml");
  if (yaml) return yaml;
  const file = getArg(args, "file");
  if (!file) throw new Error("Either --yaml or --file is required");
  return await readFile(file, "utf8");
}

export async function channel(subcommand: string, args: string[]): Promise<void> {
  if (subcommand === "add") {
    const yaml = await readYaml(args);
    const result = await executeAdminCommand(
      "snippet.import",
      { section: "channel", yaml },
      { localFallback: true }
    );
    info(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "configure") {
    const channelName = positionalArgs(args)[0];
    const exposure = getArg(args, "exposure");
    const configRaw = getArg(args, "config");
    if (!channelName) {
      error("channel name is required");
      info("Usage: openpalm channel configure <channel> [--exposure <host|lan|public>] [--config '{\"k\":\"v\"}']");
      process.exit(1);
    }
    let config: Record<string, unknown> | undefined = undefined;
    if (configRaw) {
      try {
        const parsed = JSON.parse(configRaw) as unknown;
        const parsedType =
          parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
        if (parsedType !== "object")
          throw new Error(`channel config must be a JSON object, received: ${parsedType}`);
        config = parsed as Record<string, unknown>;
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message.startsWith("channel config must be"))
          throw parseError;
        throw new Error("channel config must be a valid JSON object");
      }
    }
    const result = await executeAdminCommand(
      "channel.configure",
      {
        channel: channelName,
        ...(exposure ? { exposure } : {}),
        ...(config ? { config } : {}),
      },
      { localFallback: true }
    );
    info(JSON.stringify(result, null, 2));
    return;
  }
  error(`Unknown channel subcommand: ${subcommand}`);
  info("Usage: openpalm channel add <yaml-or-file-path>");
  info("   or: openpalm channel configure <channel> [--exposure <host|lan|public>] [--config '{\"k\":\"v\"}']");
  process.exit(1);
}
