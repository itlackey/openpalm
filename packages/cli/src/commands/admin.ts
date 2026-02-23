import { join } from "node:path";
import { readEnvFile } from "@openpalm/lib/env.ts";
import { resolveXDGPaths } from "@openpalm/lib/paths.ts";
import {
  AdminApiClient,
  resolveAdminBaseUrl,
  resolveAdminToken,
  validateAdminBaseUrl,
} from "@openpalm/lib/shared/admin-client.ts";
import { error, info } from "@openpalm/lib/ui.ts";

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function parsePayload(args: string[]): Record<string, unknown> {
  const rawPayload = getArg(args, "payload");
  if (!rawPayload) return {};
  const parsed = JSON.parse(rawPayload) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("payload_must_be_json_object");
  }
  return parsed as Record<string, unknown>;
}

export async function admin(subcommand: string, args: string[]): Promise<void> {
  if (subcommand !== "command") {
    error(`Unknown admin subcommand: ${subcommand}`);
    info("Usage: openpalm admin command --type <command-type> [--payload '{\"k\":\"v\"}']");
    process.exit(1);
  }
  const commandType = getArg(args, "type");
  if (!commandType) {
    error("--type <command-type> is required");
    process.exit(1);
  }

  const stateEnvPath = join(resolveXDGPaths().state, ".env");
  let stateEnv: Record<string, string> = {};
  try {
    stateEnv = await readEnvFile(stateEnvPath);
  } catch {
    stateEnv = {};
  }
  const env = {
    ...stateEnv,
    ...Bun.env,
  };
  const token = resolveAdminToken(env);
  if (!token) {
    error("OPENPALM_ADMIN_TOKEN or ADMIN_TOKEN is required");
    process.exit(1);
  }
  const baseUrl = resolveAdminBaseUrl(env);
  validateAdminBaseUrl(baseUrl, Bun.env.OPENPALM_ALLOW_INSECURE_ADMIN_HTTP === "1");
  const timeoutMs = Number(Bun.env.OPENPALM_ADMIN_TIMEOUT_MS ?? "15000");
  const payload = parsePayload(args);

  const client = new AdminApiClient({
    baseUrl,
    token,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000,
  });
  const result = await client.command(commandType, payload);
  info(JSON.stringify(result, null, 2));
}
