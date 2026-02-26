import { join } from "node:path";
import { readEnvFile } from "@openpalm/lib/env.ts";
import { resolveXDGPaths } from "@openpalm/lib/paths.ts";
import {
  AdminApiClient,
  resolveAdminBaseUrl,
  resolveAdminToken,
  validateAdminBaseUrl,
} from "@openpalm/lib/shared/admin-client.ts";

const DEFAULT_ADMIN_TIMEOUT_MS = 15000;
const ASSISTANT_STATE_ENV_RELATIVE_PATH = "assistant/.env";

async function mergedEnv(): Promise<Record<string, string | undefined>> {
  const stateRoot = resolveXDGPaths().state;
  const stateEnvPath = join(stateRoot, ".env");
  const assistantStateEnvPath = join(stateRoot, ASSISTANT_STATE_ENV_RELATIVE_PATH);
  let stateEnv: Record<string, string> = {};
  let assistantStateEnv: Record<string, string> = {};
  try {
    stateEnv = await readEnvFile(stateEnvPath);
  } catch {
    stateEnv = {};
  }
  try {
    assistantStateEnv = await readEnvFile(assistantStateEnvPath);
  } catch {
    assistantStateEnv = {};
  }
  const env = {
    ...stateEnv,
    ...assistantStateEnv,
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

export async function getAdminClient(): Promise<AdminApiClient> {
  const env = await mergedEnv();
  const baseUrl = resolveAdminBaseUrl(env);
  const token = resolveAdminToken(env);
  if (!token) {
    throw new Error("OPENPALM_ADMIN_TOKEN or ADMIN_TOKEN is required");
  }
  validateAdminBaseUrl(baseUrl, Bun.env.OPENPALM_ALLOW_INSECURE_ADMIN_HTTP === "1");
  const timeoutMs = parseTimeoutMs(Bun.env.OPENPALM_ADMIN_TIMEOUT_MS);
  return new AdminApiClient({ baseUrl, token, timeoutMs });
}
