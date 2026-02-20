import { composeUp } from "../lib/compose.ts";
import { loadComposeConfig } from "../lib/config.ts";
import { info, green } from "../lib/ui.ts";

export async function start(services?: string[]): Promise<void> {
  const config = await loadComposeConfig();
  info("Starting services...");
  await composeUp(config, services);
  info(green("Services started."));
}
