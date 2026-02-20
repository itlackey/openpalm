import { composeRestart } from "../lib/compose.ts";
import { loadComposeConfig } from "../lib/config.ts";
import { info, green } from "../lib/ui.ts";

export async function restart(services?: string[]): Promise<void> {
  const config = await loadComposeConfig();
  info("Restarting services...");
  await composeRestart(config, services);
  info(green("Services restarted."));
}
