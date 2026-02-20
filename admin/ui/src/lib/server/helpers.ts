/**
 * Shared server-side helpers extracted from the original admin/src/server.ts.
 * Includes controller proxy, Caddyfile manipulation, channel config I/O,
 * env file I/O, and config helpers.
 */

import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseJsonc, stringifyPretty, parseRuntimeEnvContent, sanitizeEnvScalar, setRuntimeBindScopeContent, updateRuntimeEnvContent } from "@openpalm/lib";
import type { ModelAssignment } from "@openpalm/lib";
import {
  ADMIN_TOKEN, CONTROLLER_URL, CONTROLLER_TOKEN, GATEWAY_URL,
  CADDYFILE_PATH, CHANNEL_ENV_DIR, OPENCODE_CORE_URL, OPENMEMORY_URL,
  RUNTIME_ENV_PATH, SECRETS_ENV_PATH, OPENCODE_CONFIG_PATH,
  CHANNEL_SERVICES, CHANNEL_SERVICE_SET, CHANNEL_ENV_KEYS, CHANNEL_FIELD_META
} from './env.js';
import { getSetupManager, getProviderStore } from './stores.js';

// ── Auth ──────────────────────────────────────────────────────────────

export function auth(req: Request): boolean {
  return req.headers.get("x-admin-token") === ADMIN_TOKEN;
}

// ── JSON response helper ──────────────────────────────────────────────

export function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// ── CORS ──────────────────────────────────────────────────────────────

export function cors(resp: Response): Response {
  resp.headers.set("access-control-allow-origin", "*");
  resp.headers.set("access-control-allow-headers", "content-type, x-admin-token, x-request-id");
  resp.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return resp;
}

// ── Controller proxy ──────────────────────────────────────────────────

export async function controllerAction(action: string, service: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  if (!CONTROLLER_URL) return { ok: false, error: "controller not configured" };
  try {
    const resp = await fetch(`${CONTROLLER_URL}/${action}/${service}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-controller-token": CONTROLLER_TOKEN
      },
      body: JSON.stringify({ reason })
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = typeof body.error === "string" ? body.error : `controller returned ${resp.status}`;
      console.error(`[controllerAction] ${action}/${service}: ${errMsg}`);
      return { ok: false, error: errMsg };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[controllerAction] ${action}/${service} failed:`, msg);
    return { ok: false, error: msg };
  }
}

// ── File helpers ──────────────────────────────────────────────────────

export function snapshotFile(path: string): string {
  const backup = `${path}.${Date.now()}.bak`;
  copyFileSync(path, backup);
  return backup;
}

export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmp = join(dirname(filePath), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

export function ensureOpencodeConfigPath(): void {
  if (existsSync(OPENCODE_CONFIG_PATH)) return;
  mkdirSync(dirname(OPENCODE_CONFIG_PATH), { recursive: true });
  writeFileSync(OPENCODE_CONFIG_PATH, "{}\n", "utf8");
}

// ── Caddyfile / access scope helpers ──────────────────────────────────

export type ChannelName = "chat" | "voice" | "discord" | "telegram";

function channelRewritePath(channel: ChannelName): string {
  if (channel === "chat") return "/chat";
  if (channel === "voice") return "/voice/transcription";
  if (channel === "discord") return "/discord/webhook";
  return "/telegram/webhook";
}

function channelPort(channel: ChannelName): string {
  if (channel === "chat") return "8181";
  if (channel === "voice") return "8183";
  if (channel === "discord") return "8184";
  return "8182";
}

export function detectChannelAccess(channel: ChannelName): "lan" | "public" {
  if (!existsSync(CADDYFILE_PATH)) return "public";
  const raw = readFileSync(CADDYFILE_PATH, "utf8");
  const block = raw.match(new RegExp(`handle /channels/${channel}\\* \\{[\\s\\S]*?\\n[ \\t]*\\}`, "m"))?.[0] ?? "";
  return block.includes("abort @not_lan") ? "lan" : "public";
}

export function setChannelAccess(channel: ChannelName, access: "lan" | "public"): void {
  if (!existsSync(CADDYFILE_PATH)) throw new Error("Caddyfile not found");
  const raw = readFileSync(CADDYFILE_PATH, "utf8");
  const blockRegex = new RegExp(`handle /channels/${channel}\\* \\{[\\s\\S]*?\\n[ \\t]*\\}`, "m");
  const replacement = access === "lan"
    ? [
      `handle /channels/${channel}* {`,
      `\t\tabort @not_lan`,
      `\t\trewrite * ${channelRewritePath(channel)}`,
      `\t\treverse_proxy channel-${channel}:${channelPort(channel)}`,
      `\t}`
    ].join("\n")
    : [
      `handle /channels/${channel}* {`,
      `\t\trewrite * ${channelRewritePath(channel)}`,
      `\t\treverse_proxy channel-${channel}:${channelPort(channel)}`,
      `\t}`
    ].join("\n");

  if (!blockRegex.test(raw)) throw new Error(`missing_${channel}_route_block`);
  atomicWriteFileSync(CADDYFILE_PATH, raw.replace(blockRegex, replacement));
}

export function setAccessScope(scope: "host" | "lan"): void {
  if (!existsSync(CADDYFILE_PATH)) throw new Error("Caddyfile not found");
  const raw = readFileSync(CADDYFILE_PATH, "utf8");
  const lanRanges = "127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 ::1 fd00::/8";
  const hostRanges = "127.0.0.0/8 ::1";
  const lanMatcher = scope === "host"
    ? `@lan remote_ip ${hostRanges}`
    : `@lan remote_ip ${lanRanges}`;
  const notLanMatcher = scope === "host"
    ? `@not_lan not remote_ip ${hostRanges}`
    : `@not_lan not remote_ip ${lanRanges}`;
  if (!/@lan remote_ip/.test(raw)) throw new Error("Caddyfile missing @lan matcher");
  if (!/@not_lan not remote_ip/.test(raw)) throw new Error("Caddyfile missing @not_lan matcher");
  const next = raw
    .replace(/^\s*@lan remote_ip .+$/m, `\t${lanMatcher}`)
    .replace(/^\s*@not_lan not remote_ip .+$/m, `\t${notLanMatcher}`);
  atomicWriteFileSync(CADDYFILE_PATH, next);
}

// ── Runtime/secrets env I/O ───────────────────────────────────────────

export function setRuntimeBindScope(scope: "host" | "lan"): void {
  const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, "utf8") : "";
  const next = setRuntimeBindScopeContent(current, scope);
  writeFileSync(RUNTIME_ENV_PATH, next, "utf8");
}

export function updateRuntimeEnv(entries: Record<string, string | undefined>): void {
  const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, "utf8") : "";
  const next = updateRuntimeEnvContent(current, entries);
  writeFileSync(RUNTIME_ENV_PATH, next, "utf8");
}

export function readRuntimeEnv(): Record<string, string> {
  if (!existsSync(RUNTIME_ENV_PATH)) return {};
  return parseRuntimeEnvContent(readFileSync(RUNTIME_ENV_PATH, "utf8"));
}

export function readSecretsEnv(): Record<string, string> {
  if (!existsSync(SECRETS_ENV_PATH)) return {};
  return parseRuntimeEnvContent(readFileSync(SECRETS_ENV_PATH, "utf8"));
}

export function updateSecretsEnv(entries: Record<string, string | undefined>): void {
  const current = existsSync(SECRETS_ENV_PATH) ? readFileSync(SECRETS_ENV_PATH, "utf8") : "";
  const next = updateRuntimeEnvContent(current, entries);
  writeFileSync(SECRETS_ENV_PATH, next, "utf8");
}

// ── Channel config I/O ────────────────────────────────────────────────

function channelEnvPath(service: string): string {
  const shortName = service.replace(/^channel-/, "");
  return `${CHANNEL_ENV_DIR}/${shortName}.env`;
}

export function readChannelConfig(service: string): Record<string, string> {
  const keys = CHANNEL_ENV_KEYS[service] ?? [];
  const path = channelEnvPath(service);
  const cfg: Record<string, string> = {};
  for (const k of keys) cfg[k] = "";
  if (!existsSync(path)) return cfg;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    if (keys.includes(k.trim())) cfg[k.trim()] = rest.join("=").trim();
  }
  return cfg;
}

export function writeChannelConfig(service: string, values: Record<string, string>): void {
  const keys = CHANNEL_ENV_KEYS[service] ?? [];
  const lines = ["# Channel-specific overrides managed by admin UI"];
  for (const k of keys) {
    const v = String(values[k] ?? "").replace(/\n/g, "").trim();
    lines.push(`${k}=${v}`);
  }
  writeFileSync(channelEnvPath(service), lines.join("\n") + "\n", "utf8");
}

// ── Channel listing helper ────────────────────────────────────────────

export function listChannels() {
  return CHANNEL_SERVICES.map((service) => {
    const channelName = service.replace("channel-", "") as ChannelName;
    return {
      service,
      label: channelName.charAt(0).toUpperCase() + channelName.slice(1),
      access: detectChannelAccess(channelName),
      config: readChannelConfig(service),
      fields: (CHANNEL_ENV_KEYS[service] ?? []).map((key) => {
        const meta = CHANNEL_FIELD_META[key];
        return {
          key,
          label: meta?.label ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          type: meta?.type ?? "text",
          required: meta?.required ?? false,
          ...(meta?.helpText ? { helpText: meta.helpText } : {}),
        };
      })
    };
  });
}

// ── Misc helpers ──────────────────────────────────────────────────────

export function normalizeSelectedChannels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const selected: string[] = [];
  for (const service of value) {
    if (typeof service !== "string") continue;
    if (!CHANNEL_SERVICE_SET.has(service)) continue;
    if (selected.includes(service)) continue;
    selected.push(service);
  }
  return selected;
}

export function normalizeServiceInstanceUrl(value: unknown): string {
  return sanitizeEnvScalar(value);
}

export function getConfiguredServiceInstances() {
  const runtime = readRuntimeEnv();
  const state = getSetupManager().getState();
  return {
    openmemory: runtime.OPENMEMORY_URL ?? state.serviceInstances.openmemory ?? "",
    psql: runtime.OPENMEMORY_POSTGRES_URL ?? state.serviceInstances.psql ?? "",
    qdrant: runtime.OPENMEMORY_QDRANT_URL ?? state.serviceInstances.qdrant ?? "",
  };
}

export function getConfiguredOpenmemoryProvider() {
  const secrets = readSecretsEnv();
  return {
    openaiBaseUrl: secrets.OPENAI_BASE_URL ?? "",
    openaiApiKeyConfigured: Boolean(secrets.OPENAI_API_KEY)
  };
}

export function getConfiguredSmallModel() {
  const state = getSetupManager().getState();
  const secrets = readSecretsEnv();
  return {
    endpoint: state.smallModel.endpoint,
    modelId: state.smallModel.modelId,
    apiKeyConfigured: Boolean(secrets.OPENPALM_SMALL_MODEL_API_KEY)
  };
}

export function applySmallModelToOpencodeConfig(endpoint: string, modelId: string): void {
  if (!modelId || !existsSync(OPENCODE_CONFIG_PATH)) return;
  const raw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
  const doc = parseJsonc(raw) as Record<string, unknown>;
  doc.small_model = modelId;
  if (endpoint) {
    const parts = modelId.split("/");
    const providerId = parts.length > 1 ? parts[0] : "openpalm-small";
    const providers = (typeof doc.provider === "object" && doc.provider !== null) ? { ...doc.provider as Record<string, unknown> } : {};
    const providerOptions: Record<string, unknown> = { baseURL: endpoint };
    providerOptions.apiKey = "{env:OPENPALM_SMALL_MODEL_API_KEY}";
    providers[providerId] = { options: providerOptions };
    doc.provider = providers;
  }
  const next = stringifyPretty(doc);
  atomicWriteFileSync(OPENCODE_CONFIG_PATH, next);
}

export function applyProviderAssignment(role: ModelAssignment, providerUrl: string, providerApiKey: string, modelId: string): void {
  if (role === "small") {
    const secretKey = "OPENPALM_SMALL_MODEL_API_KEY";
    updateSecretsEnv({ [secretKey]: providerApiKey || undefined });
    applySmallModelToOpencodeConfig(providerUrl, modelId);
    getSetupManager().setSmallModel({ endpoint: providerUrl, modelId });
  } else if (role === "openmemory") {
    updateSecretsEnv({
      OPENAI_BASE_URL: providerUrl || undefined,
      OPENAI_API_KEY: providerApiKey || undefined,
    });
  }
}

export async function fetchModelsFromProvider(url: string, apiKey: string): Promise<{ id: string; object?: string }[]> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("invalid provider URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("provider URL must use http or https");
  const normalized = url.replace(/\/+$/, "");
  const modelsUrl = normalized.endsWith("/v1") ? `${normalized}/models` : `${normalized}/v1/models`;
  const headers: Record<string, string> = { "accept": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`provider returned status ${resp.status}`);
  const body = await resp.json() as { data?: { id: string; object?: string }[] };
  if (!Array.isArray(body.data)) throw new Error("unexpected response format: missing data array");
  return body.data;
}

export async function checkServiceHealth(url: string, expectJson = true): Promise<{ ok: boolean; time?: string; error?: string }> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { ok: false, error: `status ${resp.status}` };
    if (!expectJson) return { ok: true, time: new Date().toISOString() };
    const body = await resp.json() as { ok?: boolean; time?: string };
    return { ok: body.ok ?? true, time: body.time };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Re-export sanitizeEnvScalar for route handlers that need it
export { sanitizeEnvScalar } from "@openpalm/lib";
