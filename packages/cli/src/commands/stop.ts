import { composeStop } from "@openpalm/lib/compose.ts";
import { loadComposeConfig } from "@openpalm/lib/config.ts";
import { info, green } from "@openpalm/lib/ui.ts";

export async function stop(services?: string[]): Promise<void> {
  const config = await loadComposeConfig();
  info("Stopping services...");
  await composeStop(config, services);
  info(green("Services stopped."));
}
