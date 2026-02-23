import { error, info } from "@openpalm/lib/ui.ts";
import { executeAdminCommand } from "./admin.ts";

export async function automation(subcommand: string, args: string[]): Promise<void> {
  if (subcommand !== "run" && subcommand !== "trigger") {
    error(`Unknown automation subcommand: ${subcommand}`);
    info("Usage: openpalm automation <run|trigger> <automation-id>");
    process.exit(1);
  }
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    error("automation id is required");
    info("Usage: openpalm automation <run|trigger> <automation-id>");
    process.exit(1);
  }
  const result = await executeAdminCommand("automation.trigger", { id }, { localFallback: true });
  info(JSON.stringify(result, null, 2));
}
