import { readFile } from "node:fs/promises";
import { error, info } from "@openpalm/lib/ui.ts";
import { executeAdminCommand } from "./admin.ts";

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

async function readYaml(args: string[]): Promise<string> {
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
    const channelName = getArg(args, "channel");
    const exposure = getArg(args, "exposure");
    const configRaw = getArg(args, "config");
    if (!channelName) {
      error("--channel <name> is required");
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
  info("Usage: openpalm channel <add|configure> [--file <yaml-file>|--yaml '<yaml>']");
  process.exit(1);
}
