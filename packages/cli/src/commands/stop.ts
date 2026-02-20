import { composeStop } from "../lib/compose.ts";
import { loadComposeConfig } from "../lib/config.ts";
import { info, green } from "../lib/ui.ts";

export async function stop(services?: string[]): Promise<void> {
  const config = await loadComposeConfig();
  info("Stopping services...");
  await composeStop(config, services);
  info(green("Services stopped."));
}
