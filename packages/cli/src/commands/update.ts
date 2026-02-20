import { composePull, composeUp } from "../lib/compose.ts";
import { loadComposeConfig } from "../lib/config.ts";
import { info, green } from "../lib/ui.ts";

export async function update(): Promise<void> {
  const config = await loadComposeConfig();
  info("Pulling latest images...");
  await composePull(config);
  info("Recreating containers with updated images...");
  await composeUp(config, undefined, { pull: "always" });
  info(green("Update complete."));
}
