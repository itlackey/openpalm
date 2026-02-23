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

const DEFAULT_ADMIN_TIMEOUT_MS = 15000;

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function parsePayload(args: string[]): Record<string, unknown> {
  const rawPayload = getArg(args, "payload");
  if (!rawPayload) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload) as unknown;
  } catch {
    throw new Error("invalid_payload_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("payload_must_be_json_object");
  }
  return parsed as Record<string, unknown>;
}

async function mergedEnv(): Promise<Record<string, string | undefined>> {
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
  return env;
}

function parseTimeoutMs(rawTimeout: string | undefined): number {
  const timeoutCandidate = rawTimeout !== undefined ? Number(rawTimeout) : DEFAULT_ADMIN_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(timeoutCandidate) && Number.isInteger(timeoutCandidate) && timeoutCandidate > 0
    ? timeoutCandidate
    : DEFAULT_ADMIN_TIMEOUT_MS;
  return timeoutMs;
}

export function hasExplicitAdminApiConfig(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.OPENPALM_ADMIN_API_URL ||
    env.OPENPALM_ADMIN_TOKEN ||
    env.ADMIN_APP_URL ||
    env.GATEWAY_URL
  );
}

export async function adminEnvContext(): Promise<{ env: Record<string, string | undefined>; explicit: boolean }> {
  const env = await mergedEnv();
  return {
    env,
    explicit: hasExplicitAdminApiConfig(env),
  };
}

export async function executeAdminCommand(
  commandType: string,
  payload: Record<string, unknown> = {},
  options?: { localFallback?: boolean }
): Promise<unknown> {
  const env = await mergedEnv();
  let baseUrl = resolveAdminBaseUrl(env);
  if (options?.localFallback && !hasExplicitAdminApiConfig(env)) {
    baseUrl = "http://localhost:8100";
  }
  const token = resolveAdminToken(env);
  if (!token) {
    throw new Error("OPENPALM_ADMIN_TOKEN or ADMIN_TOKEN is required");
  }
  validateAdminBaseUrl(baseUrl, Bun.env.OPENPALM_ALLOW_INSECURE_ADMIN_HTTP === "1");
  const timeoutMs = parseTimeoutMs(Bun.env.OPENPALM_ADMIN_TIMEOUT_MS);

  const client = new AdminApiClient({
    baseUrl,
    token,
    timeoutMs,
  });
  return await client.command(commandType, payload);
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
  const payload = parsePayload(args);
  const result = await executeAdminCommand(commandType, payload, { localFallback: true });
  info(JSON.stringify(result, null, 2));
}
