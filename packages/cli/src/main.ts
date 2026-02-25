#!/usr/bin/env bun
import type { ContainerPlatform, InstallOptions, UninstallOptions } from "./types.ts";
import { install } from "./commands/install.ts";
import { uninstall } from "./commands/uninstall.ts";
import { update } from "./commands/update.ts";
import { start } from "./commands/start.ts";
import { stop } from "./commands/stop.ts";
import { restart } from "./commands/restart.ts";
import { logs } from "./commands/logs.ts";
import { status } from "./commands/status.ts";
import { extensions } from "./commands/extensions.ts";
import { preflight } from "./commands/preflight.ts";
import { createChannel } from "./commands/create-channel.ts";
import { service } from "./commands/service.ts";
import { channel } from "./commands/channel.ts";
import { automation } from "./commands/automation.ts";
import { log, error, bold, dim } from "@openpalm/lib/ui.ts";
import pkg from "../package.json";

const VERSION = pkg.version;

function printHelp(): void {
  log(bold("openpalm") + dim(` v${VERSION}`));
  log("");
  log(bold("Usage:"));
  log("  openpalm <command> [options]");
  log("");
  log(bold("Commands:"));
  log("  install        Install and start OpenPalm");
  log("  uninstall      Stop and remove OpenPalm");
  log("  update         Pull latest images and recreate containers");
  log("  start          Start services");
  log("  stop           Stop services");
  log("  restart        Restart services");
  log("  logs           View container logs");
  log("  status         Show container status");
  log("  service        Service lifecycle operations (up, stop, restart, logs, update, status)");
  log("  channel        Channel operations (add, configure)");
  log("  automation     Automation operations (run, trigger)");
  log("  extensions     Manage extensions (install, uninstall, list)");
  log("  dev            Development helpers (preflight, create-channel)");
  log("  version        Print version");
  log("  help           Show this help");
  log("");
  log(bold("Install options:"));
  log("  --runtime <docker|podman|orbstack>  Force container runtime");
  log("  --no-open                           Don't auto-open browser");
  log("  --ref <branch|tag>                  Git ref for asset download");
  log("  --force                             Overwrite existing installation");
  log("  --port <number>                     Use alternative port (default: 80)");
  log("");
  log(bold("Uninstall options:"));
  log("  --runtime <docker|podman|orbstack>  Force container runtime");
  log("  --remove-all                        Remove all data/config/state and CLI binary");
  log("  --remove-images                     Remove container images");
  log("  --remove-binary                     Remove the openpalm CLI binary");
  log("  --yes                               Skip confirmation prompts");
  log("");
  log(bold("Management commands accept optional service names:"));
  log("  openpalm start [service...]");
  log("  openpalm stop [service...]");
  log("  openpalm restart [service...]");
  log("  openpalm logs [service...]");
  log("");
  log(bold("Extensions:"));
  log("  openpalm extensions install --plugin <id>");
  log("  openpalm extensions uninstall --plugin <id>");
  log("  openpalm extensions list");
  log("");
  log(bold("Domain commands:"));
  log("  openpalm service restart assistant");
  log("  openpalm channel add --file /path/to/channel.yaml");
  log("  openpalm automation run daily-status");
}

function parseArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < args.length) {
    return args[index + 1];
  }
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function getPositionalArgs(args: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      // Skip flag and its value if it has one
      const flagName = args[i].slice(2);
      if (["runtime", "ref", "plugin", "port"].includes(flagName)) {
        i += 2; // skip flag + value
      } else {
        i += 1; // skip boolean flag
      }
    } else {
      result.push(args[i]);
      i += 1;
    }
  }
  return result;
}

const VALID_RUNTIMES: readonly ContainerPlatform[] = ["docker", "podman", "orbstack"] as const;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    log(`openpalm v${VERSION}`);
    return;
  }

  try {
    switch (command) {
      case "install": {
        if (args.includes("--help") || args.includes("-h")) {
          printHelp();
          return;
        }
        const runtimeArg = parseArg(args, "runtime");
        if (runtimeArg && !VALID_RUNTIMES.includes(runtimeArg as ContainerPlatform)) {
          error(`Invalid runtime "${runtimeArg}". Must be one of: ${VALID_RUNTIMES.join(", ")}`);
          process.exit(1);
        }
        const portArg = parseArg(args, "port");
        const port = portArg ? Number(portArg) : undefined;
        if (portArg && (!port || port < 1 || port > 65535)) {
          error(`Invalid port "${portArg}". Must be a number between 1 and 65535.`);
          process.exit(1);
        }
        const options: InstallOptions = {
          runtime: runtimeArg as ContainerPlatform | undefined,
          noOpen: hasFlag(args, "no-open"),
          ref: parseArg(args, "ref"),
          force: hasFlag(args, "force"),
          port,
        };
        await install(options);
        break;
      }

      case "uninstall": {
        const uninstallRuntimeArg = parseArg(args, "runtime");
        if (uninstallRuntimeArg && !VALID_RUNTIMES.includes(uninstallRuntimeArg as ContainerPlatform)) {
          error(`Invalid runtime "${uninstallRuntimeArg}". Must be one of: ${VALID_RUNTIMES.join(", ")}`);
          process.exit(1);
        }
        const removeAll = hasFlag(args, "remove-all");
        const options: UninstallOptions = {
          runtime: uninstallRuntimeArg as ContainerPlatform | undefined,
          removeAll,
          removeImages: hasFlag(args, "remove-images"),
          removeBinary: removeAll || hasFlag(args, "remove-binary"),
          yes: hasFlag(args, "yes"),
        };
        await uninstall(options);
        break;
      }

      case "update": {
        await update();
        break;
      }

      case "start": {
        const services = getPositionalArgs(args);
        await start(services.length > 0 ? services : undefined);
        break;
      }

      case "stop": {
        const services = getPositionalArgs(args);
        await stop(services.length > 0 ? services : undefined);
        break;
      }

      case "restart": {
        const services = getPositionalArgs(args);
        await restart(services.length > 0 ? services : undefined);
        break;
      }

      case "logs": {
        const services = getPositionalArgs(args);
        await logs(services.length > 0 ? services : undefined);
        break;
      }

      case "status":
      case "ps": {
        await status();
        break;
      }

      case "extensions":
      case "ext": {
        const [subcommand, ...extArgs] = args;
        if (!subcommand) {
          error("Missing subcommand. Usage: openpalm extensions <install|uninstall|list>");
          process.exit(1);
        }
        await extensions(subcommand, extArgs);
        break;
      }

      case "service": {
        const [subcommand, ...serviceArgs] = args;
        if (!subcommand) {
          error("Missing subcommand. Usage: openpalm service <up|stop|restart|logs|update|status>");
          process.exit(1);
        }
        await service(subcommand, serviceArgs);
        break;
      }

      case "channel": {
        const [subcommand, ...channelArgs] = args;
        if (!subcommand) {
          error("Missing subcommand. Usage: openpalm channel <add|configure>");
          process.exit(1);
        }
        await channel(subcommand, channelArgs);
        break;
      }

      case "automation": {
        const [subcommand, ...automationArgs] = args;
        if (!subcommand) {
          error("Missing subcommand. Usage: openpalm automation <run|trigger>");
          process.exit(1);
        }
        await automation(subcommand, automationArgs);
        break;
      }

      case "dev": {
        const [subcommand, ...devArgs] = args;
        if (!subcommand) {
          error("Missing subcommand. Usage: openpalm dev <preflight|create-channel>");
          process.exit(1);
        }
        if (subcommand === "preflight") {
          preflight();
          break;
        }
        if (subcommand === "create-channel") {
          createChannel(devArgs);
          break;
        }
        error(`Unknown dev subcommand: ${subcommand}`);
        process.exit(1);
      }

      default: {
        error(`Unknown command: ${command}`);
        log("Run 'openpalm help' for usage information.");
        process.exit(1);
      }
    }
  } catch (err) {
    if (err instanceof Error) {
      error(err.message);
    } else {
      error(String(err));
    }
    process.exit(1);
  }
}

main();
