import { composeLogs } from "../lib/compose.ts";
import { loadComposeConfig } from "../lib/config.ts";

export async function logs(services?: string[]): Promise<void> {
  const config = await loadComposeConfig();
  await composeLogs(config, services?.length ? services : undefined, { follow: true, tail: 50 });
}
