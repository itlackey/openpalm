import { join } from "node:path";
import { readEnvFile } from "@openpalm/lib/env.ts";
import { resolveXDGPaths } from "@openpalm/lib/paths.ts";
import { error, info } from "@openpalm/lib/ui.ts";

/**
 * Implements the extensions command for managing OpenPalm extensions.
 * @param subcommand - The subcommand to execute: "install", "uninstall", or "list"
 * @param args - Remaining CLI arguments (may contain --plugin <id>)
 */
export async function extensions(
  subcommand: string,
  args: string[]
): Promise<void> {
  // Helper function to find argument value
  function getArg(name: string): string | undefined {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
  }

  // Get admin token from environment or state .env file
  let adminToken = Bun.env.ADMIN_TOKEN;
  if (!adminToken) {
    try {
      const stateEnvPath = join(resolveXDGPaths().state, ".env");
      const envVars = await readEnvFile(stateEnvPath);
      adminToken = envVars.ADMIN_TOKEN;
    } catch {
      // Ignore errors reading env file
    }
  }

  if (!adminToken) {
    error("ADMIN_TOKEN not found in environment or state .env file");
    process.exit(1);
  }

  // Determine base URL
  const base =
    Bun.env.ADMIN_APP_URL ??
    Bun.env.GATEWAY_URL ??
    "http://localhost";

  // Build headers
  const headers = {
    "content-type": "application/json",
    "x-admin-token": adminToken,
  };

  /** Check HTTP response status and throw on failure. */
  function checkResponse(response: Response, action: string): void {
    if (!response.ok) {
      throw new Error(
        `${action} failed: HTTP ${response.status} ${response.statusText}`
      );
    }
  }

  try {
    switch (subcommand) {
      case "install": {
        const pluginId = getArg("plugin");
        if (!pluginId) {
          error("--plugin <id> is required for install");
          info("Usage: openpalm extensions install --plugin <id>");
          process.exit(1);
        }

        const response = await fetch(`${base}/plugins/install`, {
          method: "POST",
          headers,
          body: JSON.stringify({ pluginId }),
        });

        checkResponse(response, "Extension install");
        const text = await response.text();
        info(text);
        break;
      }

      case "uninstall": {
        const pluginId = getArg("plugin");
        if (!pluginId) {
          error("--plugin <id> is required for uninstall");
          info("Usage: openpalm extensions uninstall --plugin <id>");
          process.exit(1);
        }

        const response = await fetch(`${base}/plugins/uninstall`, {
          method: "POST",
          headers,
          body: JSON.stringify({ pluginId }),
        });

        checkResponse(response, "Extension uninstall");
        const text = await response.text();
        info(text);
        break;
      }

      case "list": {
        const response = await fetch(`${base}/installed`, {
          method: "GET",
          headers,
        });

        checkResponse(response, "Extension list");
        const text = await response.text();
        info(text);
        break;
      }

      default:
        error(`Unknown subcommand: ${subcommand}`);
        info("Usage: openpalm extensions <install|uninstall|list> [--plugin <id>]");
        process.exit(1);
    }
  } catch (err) {
    error(`Failed to execute extensions command: ${err}`);
    process.exit(1);
  }
}
