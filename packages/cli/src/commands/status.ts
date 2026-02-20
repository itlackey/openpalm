import { composePs } from "../lib/compose.ts";
import { loadComposeConfig } from "../lib/config.ts";
import { log } from "../lib/ui.ts";

export async function status(): Promise<void> {
  const config = await loadComposeConfig();
  const output = await composePs(config);
  log(output);
}
