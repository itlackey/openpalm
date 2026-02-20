import { extensions } from "../../../packages/cli/src/commands/extensions.ts";

const [,, subcommand, ...args] = Bun.argv;

if (!subcommand) {
  console.log("Usage: openpalm extensions <install|uninstall|list> [--plugin <id>]");
  process.exit(1);
}

await extensions(subcommand, args);
