import { error, info } from "@openpalm/lib/ui.ts";
import { executeAdminCommand } from "./admin.ts";

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

export async function automation(subcommand: string, args: string[]): Promise<void> {
  if (subcommand !== "run" && subcommand !== "trigger") {
    error(`Unknown automation subcommand: ${subcommand}`);
    info("Usage: openpalm automation <run|trigger> --id <automation-id>");
    process.exit(1);
  }
  const id = getArg(args, "id") ?? args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    error("--id <automation-id> is required");
    process.exit(1);
  }
  const result = await executeAdminCommand("automation.trigger", { id }, { localFallback: true });
  info(JSON.stringify(result, null, 2));
}
