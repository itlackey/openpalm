import { join } from "node:path";
import type { ComposeConfig } from "../types.ts";
import { composePull, composeUp } from "../lib/compose.ts";
import { readEnvFile } from "../lib/env.ts";
import { resolveXDGPaths } from "../lib/paths.ts";
import { info, green } from "../lib/ui.ts";

async function loadComposeConfig(): Promise<ComposeConfig> {
  const xdg = resolveXDGPaths();
  const envPath = join(xdg.state, ".env");
  const env = await readEnvFile(envPath);
  return {
    bin: env.OPENPALM_COMPOSE_BIN ?? "docker",
    subcommand: env.OPENPALM_COMPOSE_SUBCOMMAND ?? "compose",
    envFile: envPath,
    composeFile: join(xdg.state, "docker-compose.yml"),
  };
}

export async function update(): Promise<void> {
  const config = await loadComposeConfig();
  info("Pulling latest images...");
  await composePull(config);
  info("Recreating containers with updated images...");
  await composeUp(config, undefined, { pull: "always" });
  info(green("Update complete."));
}
