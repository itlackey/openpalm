import { composePs } from "@openpalm/lib/compose.ts";
import { loadComposeConfig } from "@openpalm/lib/config.ts";
import { log } from "@openpalm/lib/ui.ts";

export async function status(): Promise<void> {
  const config = await loadComposeConfig();
  const output = await composePs(config);
  log(output);
}
