import { composeRestart } from "@openpalm/lib/compose.ts";
import { loadComposeConfig } from "@openpalm/lib/config.ts";
import { info, green } from "@openpalm/lib/ui.ts";

export async function restart(services?: string[]): Promise<void> {
  const config = await loadComposeConfig();
  info("Restarting services...");
  await composeRestart(config, services);
  info(green("Services restarted."));
}
