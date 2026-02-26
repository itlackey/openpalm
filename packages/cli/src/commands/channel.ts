import { error, info } from "@openpalm/lib/ui.ts";
import { getAdminClient } from "./admin.ts";

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
      if (flag === "exposure" || flag === "config") {
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

export async function channel(subcommand: string, args: string[]): Promise<void> {
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
    const client = await getAdminClient();
    const specResult = await client.getStackSpec() as { spec: Record<string, any> };
    const spec = specResult.spec;
    if (!spec.channels || !spec.channels[channelName]) {
      throw new Error(`Unknown channel: ${channelName}`);
    }
    if (exposure) spec.channels[channelName].exposure = exposure;
    if (config) spec.channels[channelName].config = { ...spec.channels[channelName].config, ...config };
    await client.setStackSpec(spec);
    await client.applyStack();
    info(`Channel ${channelName} configured successfully`);
    return;
  }
  error(`Unknown channel subcommand: ${subcommand}`);
  info("Usage: openpalm channel configure <channel> [--exposure <host|lan|public>] [--config '{\"k\":\"v\"}']");
  process.exit(1);
}
