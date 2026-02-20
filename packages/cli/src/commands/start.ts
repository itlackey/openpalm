import { composeUp } from "@openpalm/lib/compose.ts";
import { loadComposeConfig } from "@openpalm/lib/config.ts";
import { info, green } from "@openpalm/lib/ui.ts";

export async function start(services?: string[]): Promise<void> {
  const config = await loadComposeConfig();
  info("Starting services...");
  await composeUp(config, services);
  info(green("Services started."));
}
