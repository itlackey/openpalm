#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { InstallOptions, UninstallOptions } from "./types.ts";
import { install } from "./commands/install.ts";
import { uninstall } from "./commands/uninstall.ts";
import { update } from "./commands/update.ts";
import { start } from "./commands/start.ts";
import { stop } from "./commands/stop.ts";
import { restart } from "./commands/restart.ts";
import { logs } from "./commands/logs.ts";
import { status } from "./commands/status.ts";
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
  log("  version        Print version");
  log("  help           Show this help");
  log("");
  log(bold("Install options:"));
  log("  --force                    Overwrite existing installation");
  log("  --port <number>            Use alternative port (default: 80)");
  log("");
  log(bold("Uninstall options:"));
  log("  --remove-all               Remove all data/config/state and CLI binary");
  log("  --remove-images            Remove container images");
  log("  --remove-binary            Remove the openpalm CLI binary");
  log("  --yes                      Skip confirmation prompts");
  log("");
  log(bold("Management commands accept optional service names:"));
  log("  openpalm start [service...]");
  log("  openpalm stop [service...]");
  log("  openpalm restart [service...]");
  log("  openpalm logs [service...]");
}

export function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    strict: false,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      force: { type: "boolean" },
      "remove-all": { type: "boolean" },
      "remove-images": { type: "boolean" },
      "remove-binary": { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
}

export async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    log(`openpalm v${VERSION}`);
    return;
  }

  const parsed = parseCliArgs(args);
  const flag = (name: string) => parsed.values[name] === true;
  const positionals = parsed.positionals;

  try {
    switch (command) {
      case "install": {
        if (args.includes("--help") || args.includes("-h")) {
          printHelp();
          return;
        }
        const portArg = typeof parsed.values.port === "string" ? parsed.values.port : undefined;
        const port = portArg ? Number(portArg) : undefined;
        if (portArg && (!port || port < 1 || port > 65535)) {
          error(`Invalid port "${portArg}". Must be a number between 1 and 65535.`);
          process.exit(1);
        }
        const options: InstallOptions = { force: flag("force"), port };
        await install(options);
        break;
      }

      case "uninstall": {
        const removeAll = flag("remove-all");
        const options: UninstallOptions = {
          removeAll,
          removeImages: flag("remove-images"),
          removeBinary: removeAll || flag("remove-binary"),
          yes: flag("yes"),
        };
        await uninstall(options);
        break;
      }

      case "update": {
        await update();
        break;
      }

      case "start": {
        await start(positionals.length > 0 ? positionals : undefined);
        break;
      }

      case "stop": {
        await stop(positionals.length > 0 ? positionals : undefined);
        break;
      }

      case "restart": {
        await restart(positionals.length > 0 ? positionals : undefined);
        break;
      }

      case "logs": {
        await logs(positionals.length > 0 ? positionals : undefined);
        break;
      }

      case "status":
      case "ps": {
        await status();
        break;
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

if (import.meta.main) {
  main();
}
