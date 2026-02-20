import { join } from "node:path";
import type { ComposeConfig } from "./types.ts";
import { readEnvFile } from "./env.ts";
import { resolveXDGPaths } from "./paths.ts";

/**
 * Load compose configuration from the XDG state .env file.
 * Used by all management commands (update, start, stop, restart, logs, status).
 */
export async function loadComposeConfig(): Promise<ComposeConfig> {
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
